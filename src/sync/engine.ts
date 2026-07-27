/**
 * One sync pass: ask GitHub what is open, make sure the objects are local, update the store.
 *
 * Cost per pass is one `gh` request plus, at most, one `git fetch` — and the fetch only
 * runs for pull requests whose head commit we do not already have, so a quiet minute
 * transfers nothing.
 */

import type { PullRequest } from '../core/types.js';
import type { Config } from '../core/config.js';
import { log, timed } from '../core/log.js';
import { matchesAny } from '../core/glob.js';
import type { Repository } from '../providers/repository.js';
import { prRef } from '../providers/git.js';
import type { Store } from '../model/store.js';
import type { Analyzer } from '../model/analyzer.js';

export class SyncEngine {
  private login: string | undefined;
  private probed = false;
  private lastHeadSha: string | undefined;
  /** Set by the developer fixture command; bypasses gh entirely. */
  private fixture: PullRequest[] | undefined;

  constructor(
    private readonly repository: Repository,
    private readonly store: Store,
    private readonly analyzer: Analyzer
  ) {}

  useFixture(pullRequests: PullRequest[] | undefined): void {
    this.fixture = pullRequests;
    this.probed = false;
  }

  get isUsingFixture(): boolean {
    return this.fixture !== undefined;
  }

  get currentLogin(): string | undefined {
    return this.login;
  }

  /**
   * Run a sync pass.
   *
   * Never throws: a failing sync degrades the UI with a stated reason instead of
   * surfacing an exception, because this runs on a timer and a modal every 60 seconds
   * would be intolerable.
   */
  async sync(config: Config): Promise<void> {
    this.store.setStatus({ state: 'syncing' });

    try {
      await this.detectHeadMove();

      const pullRequests = this.fixture
        ? this.applyFilters(this.fixture, config)
        : await this.fetchPullRequests(config);

      if (pullRequests === undefined) return;

      const closed = this.store.setPullRequests(pullRequests);

      if (this.fixture) {
        this.store.setStatus({ state: 'ready', message: 'Offline fixture' });
        return;
      }

      await this.reconcileRefs(pullRequests, closed, config);
    } catch (error) {
      log.error('sync failed', error);
      this.store.setStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /** Returns undefined when the store has already been put into a degraded state. */
  private async fetchPullRequests(config: Config): Promise<PullRequest[] | undefined> {
    if (!this.probed) {
      const state = await this.repository.gh.probe();
      switch (state.kind) {
        case 'missing':
          this.store.setDegraded('gh-missing', 'The GitHub CLI (gh) was not found on your PATH.');
          return undefined;
        case 'unauthenticated':
          this.store.setDegraded('gh-unauthenticated', 'Run `gh auth login` to connect to GitHub.');
          return undefined;
        case 'no-repo':
          this.store.setDegraded('no-remote', state.message);
          return undefined;
        case 'ok':
          this.login = state.login;
          this.probed = true;
          log.info(`connected to ${state.nameWithOwner} as ${state.login}`);
          break;
      }
    }

    const raw = await timed('gh pr list', () =>
      this.repository.gh.listPullRequests(config.maxPullRequests, config.includeDrafts)
    );

    return this.applyFilters(raw, config);
  }

  /**
   * Drop what the user does not want to see, then drop pull requests left with nothing.
   *
   * Own pull requests are excluded by default: the point is to surface work you cannot
   * see in your own editor, and your own branch is already visible to you.
   */
  private applyFilters(pullRequests: readonly PullRequest[], config: Config): PullRequest[] {
    const mutedNumbers = new Set(config.mutedPullRequests);
    const mutedAuthors = new Set(config.mutedAuthors);

    return pullRequests
      .filter((pr) => !mutedNumbers.has(pr.number))
      .filter((pr) => !mutedAuthors.has(pr.author.toLowerCase()))
      .filter((pr) => config.includeDrafts || !pr.isDraft)
      .filter(
        (pr) =>
          config.includeOwnPullRequests ||
          !this.login ||
          pr.author.toLowerCase() !== this.login.toLowerCase()
      )
      .map((pr) => ({
        ...pr,
        files: pr.files.filter((file) => !matchesAny(file.path, config.ignoreGlobs))
      }))
      .filter((pr) => pr.files.length > 0);
  }

  /** Make sure every open pull request's head is local, and forget the ones that closed. */
  private async reconcileRefs(
    pullRequests: readonly PullRequest[],
    closed: readonly number[],
    config: Config
  ): Promise<void> {
    if (closed.length > 0) {
      await this.repository.git.deleteRefs(closed);
      log.debug(`pruned refs for closed pull requests: ${closed.join(', ')}`);
    }

    if (!config.fetchPullRequestRefs) {
      this.store.setDegraded(
        'fetch-disabled',
        'Line-level indicators are off because gitray.fetchPullRequestRefs is disabled.'
      );
      return;
    }

    if (!(await this.repository.git.hasRemote())) {
      this.store.setDegraded('no-remote', 'This repository has no `origin` remote to fetch from.');
      return;
    }

    if (await this.repository.git.isShallow()) {
      // Without full history there may be no reachable merge base, and a wrong merge base
      // silently produces indicators on the wrong lines. File-level is the safe answer.
      this.store.setDegraded(
        'fetch-failed',
        'This is a shallow clone, so merge bases are unavailable. Run `git fetch --unshallow` for line-level indicators.'
      );
      return;
    }

    // Fetch when our ref is missing or points somewhere other than the current head, so
    // a force push or a manual ref cleanup both heal on the next pass.
    const missing: number[] = [];
    for (const pr of pullRequests) {
      const current = await this.repository.git.refOid(prRef(pr.number));
      if (current !== pr.headRefOid) missing.push(pr.number);
    }

    if (missing.length > 0) {
      log.info(`fetching ${missing.length} pull request head(s): ${missing.join(', ')}`);
      try {
        await timed('git fetch', () => this.repository.git.fetchPullRequests(missing));
      } catch (error) {
        log.warn(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
        this.store.setDegraded(
          'fetch-failed',
          'Could not fetch pull request heads. Showing file-level indicators only.'
        );
        return;
      }
    }

    this.store.setStatus({ state: 'ready', message: undefined, reason: undefined });
  }

  /**
   * Notice when HEAD moved and throw away every derived coordinate.
   *
   * A commit, checkout, or rebase changes the merge base with every pull request, which
   * invalidates all cached ranges at once. Missing this would leave indicators pointing
   * at lines that no longer mean anything.
   */
  private async detectHeadMove(): Promise<void> {
    const head = await this.repository.git.headSha();
    if (head !== this.lastHeadSha) {
      if (this.lastHeadSha !== undefined) {
        log.info('HEAD moved; recomputing against the new merge base');
        this.analyzer.reset();
        this.store.invalidateAll();
      }
      this.lastHeadSha = head;
    }
  }
}

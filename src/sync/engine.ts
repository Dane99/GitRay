/**
 * One sync pass: ask GitHub what is open, make sure the objects are local, update the store.
 *
 * Cost per pass is one metadata request plus, at most, one `git fetch` — and the fetch only
 * runs for pull requests whose head commit we do not already have, so a quiet minute
 * transfers nothing.
 */

import type { MainlineState, PullRequest } from '../core/types.js';
import { isMutedAuthor, type Config } from '../core/config.js';
import { log, timed } from '../core/log.js';
import { matchesAny } from '../core/glob.js';
import type { Repository } from '../providers/repository.js';
import { toState, type GitHubFailure } from '../providers/github.js';
import { prRef } from '../providers/git.js';
import { describeUnusableRemote } from '../providers/remoteSelection.js';
import type { Store } from '../model/store.js';
import type { Analyzer } from '../model/analyzer.js';

/**
 * How long GitRay will go without re-checking the mainline.
 *
 * The event that matters — a pull request leaving the open list — triggers a fetch
 * directly, so this floor exists only for the merges that arrive without one: a direct
 * push to main, or a merge by someone whose pull request GitRay never saw. Five minutes
 * of staleness on that path is a fair trade for not opening a connection every minute.
 */
const MAINLINE_MAX_AGE_MS = 5 * 60_000;

/**
 * Marker for "we have never even tried", so the first pass of a session always fetches.
 * Any real timestamp is far enough in the past to satisfy the age check anyway.
 */
const NEVER = 0;

export class SyncEngine {
  private login: string | undefined;
  private probed = false;
  /** The remote the settled transport was probed against. See `detectRemoteChange`. */
  private probedRemote: string | undefined;
  private lastHeadSha: string | undefined;
  private mainlineBranch: string | undefined;
  /** When the mainline fetch was last *attempted* — success or not. See below. */
  private mainlineFetchedAt = NEVER;
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

  /**
   * Run a sync pass.
   *
   * Never throws: a failing sync degrades the UI with a stated reason instead of
   * surfacing an exception, because this runs on a timer and a modal every 60 seconds
   * would be intolerable. The return value is how the scheduler learns about transient
   * failures anyway — false means "the network let us down, back off", while persistent
   * conditions like being signed out return true so they keep being probed at the normal
   * cadence.
   */
  async sync(config: Config): Promise<boolean> {
    try {
      await this.detectHeadMove();

      const pullRequests = this.fixture
        ? this.applyFilters(this.fixture, config)
        : await this.fetchPullRequests(config);

      if (pullRequests !== undefined) {
        const closed = this.store.setPullRequests(pullRequests);

        if (this.fixture) {
          // Drop any real mainline state read before the fixture was loaded. Leaving it
          // would show genuine drift underneath the fixture's invented pull requests,
          // which is a confusing thing for a demo mode to do.
          this.store.setMainline(undefined);
          this.store.setStatus({ state: 'ready', message: 'Offline fixture' });
          return true;
        }

        await this.reconcileRefs(pullRequests, closed, config);
        // A pull request leaving the open list is the signal that something merged, so it
        // is what makes the mainline worth re-reading right now rather than on the floor.
        await this.updateMainline(config, closed.length > 0);
      } else if (!this.fixture) {
        // No credentials, no repository, or no network. Mainline drift needs none of
        // those — it is plain git — so it keeps working when the rest of GitRay cannot.
        await this.updateMainline(config, false);
      }
    } catch (error) {
      log.error('sync failed', error);
      this.store.setStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const status = this.store.currentStatus();
    return (
      status.state !== 'error' &&
      status.reason !== 'offline' &&
      status.reason !== 'fetch-failed'
    );
  }

  /** Returns undefined when the store has already been put into a degraded state. */
  private async fetchPullRequests(config: Config): Promise<PullRequest[] | undefined> {
    await this.detectRemoteChange();

    if (!this.probed) {
      const state = await this.repository.github.probe();
      if (state.kind !== 'ok') return this.degrade(state);

      this.login = state.login;
      this.probed = true;
      this.probedRemote = await this.repository.remotes.name();
      log.info(
        `connected to ${state.nameWithOwner} as ${state.login} via ${
          state.transport === 'cli' ? 'the GitHub CLI' : 'your editor’s GitHub sign-in'
        }`
      );
    }

    try {
      const raw = await timed('list pull requests', () =>
        this.repository.github.listPullRequests(config.maxPullRequests, config.includeDrafts)
      );
      return this.applyFilters(raw, config);
    } catch (error) {
      // A session that expired, a token that was revoked, a network that went away — all
      // of them arrive here rather than at the probe, because the probe already succeeded
      // once. Re-probing next pass is what lets the CLI take over from a dead session, or
      // the other way round, without a reload.
      this.probed = false;
      log.warn(
        `could not list pull requests: ${error instanceof Error ? error.message : String(error)}`
      );
      return this.degrade(toState(error));
    }
  }

  /**
   * Put the store into the degraded state a failure calls for, and return "no answer".
   *
   * The reason matters as much as the message: it is what decides whether the sidebar
   * offers a sign-in row, and what tells the scheduler to back off rather than retry a
   * condition that will not change on its own.
   */
  private degrade(state: GitHubFailure): undefined {
    switch (state.kind) {
      case 'signed-out':
        this.store.setDegraded(state.canSignIn ? 'signed-out' : 'gh-required', state.message);
        break;
      case 'offline':
        this.store.setDegraded('offline', `GitHub is unreachable — ${state.message}`);
        break;
      case 'no-repo':
        this.store.setDegraded('not-a-repo', state.message);
        break;
    }
    return undefined;
  }

  /**
   * Drop what the user does not want to see, then drop pull requests left with nothing.
   *
   * Own pull requests are included by default. The original reasoning — your own branch is
   * already visible to you — only holds while you are standing on it: the moment you switch
   * away, your own open pull request is exactly as invisible as a colleague's, and on a
   * solo repository excluding it left GitRay with nothing to say at all. Standing on the
   * branch costs nothing either way, because the merge base with your own head is that head,
   * so the diff against it is empty and no regions are produced.
   *
   * Mute is the one filter whose casualties are kept rather than forgotten. Everything
   * else here is a standing preference; mute is a decision about a specific pull request or
   * person, and a decision you cannot see is a decision you cannot take back.
   */
  private applyFilters(pullRequests: readonly PullRequest[], config: Config): PullRequest[] {
    const mutedNumbers = new Set(config.mutedPullRequests);
    const isMuted = (pr: PullRequest): boolean =>
      mutedNumbers.has(pr.number) || isMutedAuthor(config, pr.author);

    this.store.setMutedPullRequests(pullRequests.filter(isMuted));

    return pullRequests
      .filter((pr) => !isMuted(pr))
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

    const remote = await this.repository.remotes.choose();
    if (remote.kind !== 'ok') {
      this.store.setDegraded('no-remote', describeUnusableRemote(remote));
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
      log.info(
        `fetching ${missing.length} pull request head(s) from ${remote.name}: ${missing.join(', ')}`
      );
      try {
        await timed('git fetch', () =>
          this.repository.git.fetchPullRequests(missing, remote.name)
        );
        // Say that the objects arrived. The surfaces were told about these pull requests
        // before their heads existed locally — `setPullRequests` fires synchronously and
        // this fetch is awaited after it — so the pass they ran had nothing to analyze
        // against. Nothing else announces it: the status below is already `ready`, so it
        // fires nothing, and the file would stay blank until the next poll or keystroke.
        this.store.invalidateAll();
      } catch (error) {
        log.warn(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
        // The remote is named because it is the thing most likely to be wrong: a fork whose
        // `origin` has no pull requests fails exactly here, and the message is where anyone
        // would look before finding `gitray.remote`.
        this.store.setDegraded(
          'fetch-failed',
          `Could not fetch pull request heads from \`${remote.name}\`. Showing file-level indicators only. If the pull requests live on a different remote, set \`gitray.remote\`.`
        );
        return;
      }
    }

    this.store.setStatus({ state: 'ready', message: undefined, reason: undefined });
  }

  /**
   * Work out where the mainline is, and how far your branch has fallen behind it.
   *
   * This is the half of GitRay that keeps working after a pull request merges. Everything
   * else is built on the *open* list, so a colleague's branch disappears from every surface
   * at the moment its overlap with your work stops being hypothetical. Reading the mainline
   * is what turns that silence back into a warning.
   */
  private async updateMainline(config: Config, pullRequestClosed: boolean): Promise<void> {
    if (!config.trackMainlineDrift) {
      this.store.setMainline(undefined);
      return;
    }

    // Plain git, and it has to keep working when GitHub does not — so a repository with no
    // usable remote still gets whatever an earlier session left in GitRay's namespace.
    const remote = await this.repository.remotes.name();

    const branch = await this.resolveMainlineBranch(config, remote);
    if (!branch) {
      this.store.setMainline(undefined);
      return;
    }

    // Without full history there may be no reachable merge base, and a wrong base puts
    // indicators on the wrong lines. Saying nothing beats saying something wrong.
    if (await this.repository.git.isShallow()) {
      this.store.setMainline(undefined);
      return;
    }

    if (remote && this.shouldFetchMainline(config, pullRequestClosed)) {
      try {
        await timed('git fetch mainline', () =>
          this.repository.git.fetchMainline(branch, remote)
        );
      } catch (error) {
        // Whatever is already local is still worth reporting, so a failed fetch degrades
        // to a staler answer rather than to no answer.
        log.debug(
          `mainline fetch failed: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        // The *attempt* is what is recorded, not the success. Timestamping only successes
        // would leave a session that starts offline retrying on every pass, waiting out a
        // connection timeout once a minute for as long as it stays offline. A pull request
        // closing still forces a fetch, so the event that matters is never delayed by this.
        this.mainlineFetchedAt = Date.now();
      }
    }

    const state = await this.readMainline(branch, remote);
    this.store.setMainline(state);

    if (state && state.tip !== state.base) {
      log.debug(
        `${branch} has moved ${state.commits.length} commit(s) since your branch left it`
      );
    }
  }

  /** Where the mainline is now, and where your branch left it. */
  private async readMainline(
    branch: string,
    remote: string | undefined
  ): Promise<MainlineState | undefined> {
    const { git } = this.repository;

    const tip = await git.mainlineTip(branch, remote);
    if (!tip) return undefined;

    const base = await git.mergeBase(tip);
    // Unrelated histories: no shared ancestor means no coordinate system to compare in.
    if (!base) return undefined;

    const commits = base === tip ? [] : await git.commitsIn(base, tip);
    return { branch, tip, base, commits };
  }

  /**
   * Is it worth opening a connection for the mainline right now?
   *
   * Cheap answers first: never when the user turned ref fetching off, always on the first
   * pass of a session and whenever a pull request just left the open list, and otherwise
   * only once the last attempt has gone stale.
   */
  private shouldFetchMainline(config: Config, pullRequestClosed: boolean): boolean {
    if (!config.fetchPullRequestRefs) return false;
    if (this.mainlineFetchedAt === NEVER || pullRequestClosed) return true;
    return Date.now() - this.mainlineFetchedAt >= MAINLINE_MAX_AGE_MS;
  }

  /**
   * Which branch counts as the mainline.
   *
   * An explicit setting always wins. Otherwise the remote's own default branch is the
   * right answer and costs one `symbolic-ref`; repositories where nobody ever recorded one
   * fall back to whatever the open pull requests are targeting, which is the same thing by
   * a different route. Detection is remembered, since it cannot change without a reload.
   */
  private async resolveMainlineBranch(
    config: Config,
    remote: string | undefined
  ): Promise<string | undefined> {
    if (config.mainlineBranch) return config.mainlineBranch;
    if (this.mainlineBranch) return this.mainlineBranch;

    // A fork's `upstream` usually has no recorded HEAD — `git clone` only sets one for the
    // remote it cloned from — so the pull requests' own base branch carries this case.
    const detected =
      (remote ? await this.repository.git.defaultBranch(remote) : undefined) ??
      this.mostCommonBaseRef();
    if (detected) {
      this.mainlineBranch = detected;
      log.info(`tracking mainline drift against ${detected}`);
    }
    return detected;
  }

  private mostCommonBaseRef(): string | undefined {
    const counts = new Map<string, number>();
    for (const pr of this.store.allPullRequests()) {
      counts.set(pr.baseRefName, (counts.get(pr.baseRefName) ?? 0) + 1);
    }

    let best: string | undefined;
    let bestCount = 0;
    for (const [name, count] of counts) {
      if (count > bestCount) {
        best = name;
        bestCount = count;
      }
    }
    return best;
  }

  /**
   * Re-probe when the remote moves out from under a settled transport.
   *
   * `gitray.remote` is a live setting and `git remote add upstream …` is a live repository
   * change, so the answer this engine fetches refs from can change without a reload. The
   * probe is what decides *which repository* the metadata comes from, and it normally runs
   * once per session — leaving it alone here would list pull requests from the old
   * repository while fetching their heads from the new one, which is the exact split this
   * whole change exists to close. Only the probe is thrown away; nothing refetches.
   */
  private async detectRemoteChange(): Promise<void> {
    if (!this.probed) return;

    const remote = await this.repository.remotes.name();
    if (remote === this.probedRemote) return;

    log.info(`the pull request remote changed to ${remote ?? 'none'}; re-probing`);
    this.probed = false;
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
        // Where your branch left the mainline moved too, and every surface reacts to the
        // invalidation below by scanning immediately. Dropping the state first means that
        // scan finds no mainline rather than one measured from the old HEAD; the correct
        // answer arrives from `updateMainline` a moment later in this same pass.
        this.store.setMainline(undefined);
        this.store.invalidateAll();
      }
      this.lastHeadSha = head;
    }
  }
}

/**
 * Which remote GitRay fetches from.
 *
 * `origin` is the obvious answer and the wrong one for the workflow this extension is most
 * useful in. Fork a repository and `origin` is *your* copy: it carries no `refs/pull/*`
 * worth fetching, and its default branch is however stale your last sync left it. The pull
 * requests and the mainline both live on `upstream`. Hardcoding `origin` does not fail
 * there — it fetches nothing, finds no drift, and leaves the extension quietly half-working,
 * which is harder to notice than an error and worse than one.
 *
 * Three inputs decide it, in order:
 *
 *   1. `gitray.remote`, when it is set. Honoured even when it names a remote that does not
 *      exist: being told the setting is wrong beats being silently redirected somewhere
 *      that happens to answer.
 *   2. The remote whose URL points at the repository `gh` resolved. gh already does fork
 *      base-repo resolution — including whatever `gh repo set-default` recorded — so once it
 *      has answered, its answer is better informed than anything derived from names.
 *   3. The name preference gh itself falls back to: `upstream`, then `github`, then
 *      `origin`, then whatever else is configured.
 */

import type { Git } from './git.js';
import { parseRemoteUrl, type RemoteRepository } from './remote.js';

export type RemoteChoice =
  /** A remote that exists and is the one to fetch from. */
  | { kind: 'ok'; name: string }
  /** No remotes at all. */
  | { kind: 'none' }
  /** `gitray.remote` names a remote this repository does not have. */
  | { kind: 'missing'; name: string };

/** What gh resolved for this folder: a repository, and the host it lives on. */
export interface BaseRepository {
  nameWithOwner: string;
  /** Undefined when gh reported a URL nothing could be parsed out of. */
  host: string | undefined;
}

/**
 * Why there is nothing to fetch from, in words for the sidebar.
 *
 * Shared by both transports, because both can be the first to notice. A `gitray.remote`
 * naming something that does not exist is the case worth spelling out: it is a typo, it is
 * silent otherwise, and the person who wrote the setting is the only one who can fix it.
 */
export function describeUnusableRemote(choice: Exclude<RemoteChoice, { kind: 'ok' }>): string {
  return choice.kind === 'missing'
    ? `\`gitray.remote\` is set to \`${choice.name}\`, but this repository has no remote by that name.`
    : 'This repository has no remote to fetch pull request heads from.';
}

/**
 * gh's own remote preference, and the convention every fork tutorial teaches.
 *
 * `upstream` outranking `origin` is the whole point: in a fork it is the only one of the two
 * that has the pull requests. In a plain clone there is no `upstream` to outrank anything,
 * so the order costs nothing there.
 */
const PREFERRED = ['upstream', 'github', 'origin'];

/** The most likely pull-request host among a set of remote names. */
export function preferredRemote(names: readonly string[]): string | undefined {
  for (const wanted of PREFERRED) {
    if (names.includes(wanted)) return wanted;
  }
  // Git lists remotes alphabetically, so this is stable rather than arbitrary.
  return names[0];
}

export class RemoteSelector {
  private baseRepository: BaseRepository | undefined;
  private cached: RemoteChoice | undefined;
  private cacheKey: string | undefined;

  constructor(
    private readonly git: Git,
    /**
     * `gitray.remote`, read per call rather than captured. Changing a setting must take
     * effect on the next poll, and this object outlives any one of them.
     */
    private readonly configured: () => string
  ) {}

  /**
   * Record which repository gh resolved for this folder.
   *
   * This is the good input. gh answers "which repository do this folder's pull requests
   * belong to" from the same resolution it uses for `gh pr list`, so pointing the fetch at
   * whichever remote carries that repository keeps metadata and refs describing the same
   * place. Without it the selector is guessing from names.
   */
  setBaseRepository(base: BaseRepository | undefined): void {
    if (keyOf(base) === keyOf(this.baseRepository)) return;
    this.baseRepository = base;
    this.cached = undefined;
  }

  /**
   * The remote to fetch from, or why there is not one.
   *
   * The remote *list* is read on every call rather than cached, because `git remote add
   * upstream …` is the first thing anyone reaches for and it must not need a window reload
   * to take effect — the whole point of this module is that the fork case works. That costs
   * one `git remote`, which is a local read sitting next to the fetches it decides. What is
   * cached is the expensive half: a `git remote get-url` per remote, plus the URL parsing.
   */
  async choose(): Promise<RemoteChoice> {
    const configured = this.configured().trim();
    const names = await this.git.remotes();

    const key = [configured, keyOf(this.baseRepository), names.join(' ')].join('\0');
    if (this.cached && this.cacheKey === key) return this.cached;

    const choice = await this.resolve(configured, names);
    this.cacheKey = key;
    this.cached = choice;
    return choice;
  }

  /** The remote to fetch from, or undefined when there is not one to fetch from. */
  async name(): Promise<string | undefined> {
    const choice = await this.choose();
    return choice.kind === 'ok' ? choice.name : undefined;
  }

  /** The GitHub repository the chosen remote points at, if it points at one. */
  async repository(): Promise<RemoteRepository | undefined> {
    const name = await this.name();
    return name ? this.repositoryOf(name) : undefined;
  }

  private async resolve(configured: string, names: readonly string[]): Promise<RemoteChoice> {
    if (configured) {
      return names.includes(configured)
        ? { kind: 'ok', name: configured }
        : { kind: 'missing', name: configured };
    }

    if (names.length === 0) return { kind: 'none' };

    // gh may have resolved a repository nothing here points at — a `gh repo set-default`,
    // or a fork whose parent was never added as a remote. There is no better local answer
    // in that case than the name preference below; github.ts is where it gets said out loud.
    if (this.baseRepository) {
      const matched = await this.matching(names, this.baseRepository);
      if (matched) return { kind: 'ok', name: matched };
    }

    const chosen = preferredRemote(names);
    return chosen ? { kind: 'ok', name: chosen } : { kind: 'none' };
  }

  /** The remote pointing at a given repository, preferring the conventional names. */
  private async matching(
    names: readonly string[],
    base: BaseRepository
  ): Promise<string | undefined> {
    const matches: string[] = [];
    for (const name of names) {
      const repository = await this.repositoryOf(name);
      if (repository && sameRepository(repository, base)) matches.push(name);
    }
    return preferredRemote(matches);
  }

  private async repositoryOf(name: string): Promise<RemoteRepository | undefined> {
    const url = await this.git.remoteUrl(name);
    return url ? parseRemoteUrl(url) : undefined;
  }
}

/**
 * Is this remote the repository gh resolved?
 *
 * Host as well as name, when gh reported one. `acme/api` on github.com and `acme/api` on an
 * Enterprise install are different repositories that a name comparison calls identical —
 * and a mirror of one alongside the other is exactly the setup where it happens.
 */
export function sameRepository(remote: RemoteRepository, base: BaseRepository): boolean {
  // GitHub owner and repository names are case-insensitive; a remote URL keeps whatever
  // casing it was typed with.
  if (remote.nameWithOwner.toLowerCase() !== base.nameWithOwner.toLowerCase()) return false;
  return base.host === undefined || remote.host === base.host;
}

function keyOf(base: BaseRepository | undefined): string {
  return base ? `${base.host ?? ''}/${base.nameWithOwner}` : '';
}

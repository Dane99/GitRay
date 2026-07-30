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
 * Two inputs decide it, in order:
 *
 *   1. `gitray.remote`, when it is set. Honoured even when it names a remote that does not
 *      exist: being told the setting is wrong beats being silently redirected somewhere
 *      that happens to answer.
 *   2. The conventional name preference: `upstream`, then `github`, then `origin`, then
 *      whatever else is configured.
 *
 * Nothing here asks GitHub which repository a fork was made from, deliberately. The answer
 * would be a repository this clone may well have no remote for, and the refs still have to
 * be fetched from a remote that exists — so it would name a place the fetch cannot reach.
 * `git remote add upstream …` is the fix, and the setting is there for the rest.
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

/**
 * Why there is nothing to fetch from, in words for the sidebar.
 *
 * A `gitray.remote` naming something that does not exist is the case worth spelling out: it
 * is a typo, it is silent otherwise, and the person who wrote the setting is the only one
 * who can fix it.
 */
export function describeUnusableRemote(choice: Exclude<RemoteChoice, { kind: 'ok' }>): string {
  return choice.kind === 'missing'
    ? `\`gitray.remote\` is set to \`${choice.name}\`, but this repository has no remote by that name.`
    : 'This repository has no remote to fetch pull request heads from.';
}

/**
 * The convention every fork tutorial teaches, and the one the GitHub tooling follows.
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
   * The remote to fetch from, or why there is not one.
   *
   * The remote *list* is read on every call rather than cached, because `git remote add
   * upstream …` is the first thing anyone reaches for and it must not need a window reload
   * to take effect — the whole point of this module is that the fork case works. That costs
   * one `git remote`, which is a local read sitting next to the fetches it decides.
   */
  async choose(): Promise<RemoteChoice> {
    const configured = this.configured().trim();
    const names = await this.git.remotes();

    const key = [configured, names.join(' ')].join('\0');
    if (this.cached && this.cacheKey === key) return this.cached;

    const choice = this.resolve(configured, names);
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
    if (!name) return undefined;
    const url = await this.git.remoteUrl(name);
    return url ? parseRemoteUrl(url) : undefined;
  }

  private resolve(configured: string, names: readonly string[]): RemoteChoice {
    if (configured) {
      return names.includes(configured)
        ? { kind: 'ok', name: configured }
        : { kind: 'missing', name: configured };
    }

    if (names.length === 0) return { kind: 'none' };

    const chosen = preferredRemote(names);
    return chosen ? { kind: 'ok', name: chosen } : { kind: 'none' };
  }
}

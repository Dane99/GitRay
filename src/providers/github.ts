/**
 * The one place that decides how GitRay talks to GitHub.
 *
 * There is a single transport: the GitHub session the editor already holds. Nothing has to
 * be installed, nothing has to be logged in to separately, and no credential is GitRay's to
 * keep — the editor hands over a token per request and GitRay drops it again.
 *
 * What the editor's session does not hand over is *which* repository to ask about, so that
 * is derived from a remote URL. Which remote is not this module's decision either; see
 * remoteSelection.ts. The same selector feeds the ref fetch, so the repository whose pull
 * requests are listed and the remote their heads come from cannot drift apart.
 *
 * Hosts are the one place this stays honest rather than optimistic. The editor speaks for
 * github.com out of the box and for one Enterprise server once `github-enterprise.uri` names
 * it; anything else is reported as such instead of being offered a sign-in that could not
 * work.
 */

import { log } from '../core/log.js';
import type { PullRequest } from '../core/types.js';
import type { Git } from './git.js';
import { GitHubApi, GitHubApiError, type TokenSource } from './githubApi.js';
import type { RemoteRepository } from './remote.js';
import { describeUnusableRemote, RemoteSelector } from './remoteSelection.js';

export type GitHubState =
  | { kind: 'ok'; login: string; nameWithOwner: string }
  /** No usable credentials. `canSignIn` is whether the editor's sign-in would help. */
  | { kind: 'signed-out'; message: string; canSignIn: boolean }
  | { kind: 'offline'; message: string }
  | { kind: 'no-repo'; message: string };

/** Every state except success, which is the only one the UI has to explain. */
export type GitHubFailure = Exclude<GitHubState, { kind: 'ok' }>;

export class GitHub {
  private api: GitHubApi | undefined;
  private remote: RemoteRepository | undefined;
  /** Which remote `remote` was read from, so a re-selection is noticed. */
  private remoteName: string | undefined;
  private remoteRead = false;

  constructor(
    git: Git,
    private readonly tokens: TokenSource,
    /**
     * Shared with the sync engine when there is one. The default exists for tests and for
     * anyone constructing a GitHub on its own; it resolves the same way, just privately.
     */
    private readonly remotes: RemoteSelector = new RemoteSelector(git, () => '')
  ) {}

  /** Work out whether we can talk to GitHub at all, and as whom. */
  async probe(): Promise<GitHubState> {
    // Asked first so that "the remote you named does not exist" reaches the user as itself.
    // Sync degrades here and never reaches the ref fetch that would otherwise have said it —
    // and a typo that reports as "no GitHub repository" sends whoever wrote the setting
    // looking in the wrong place entirely.
    const choice = await this.remotes.choose();
    if (choice.kind !== 'ok') {
      return { kind: 'no-repo', message: describeUnusableRemote(choice) };
    }

    const remote = await this.resolveRemote();
    if (!remote) {
      return {
        kind: 'no-repo',
        message: `The \`${choice.name}\` remote does not point at a GitHub repository.`
      };
    }

    if (!this.tokens.supports(remote.host)) {
      return {
        kind: 'signed-out',
        canSignIn: false,
        message:
          `GitRay signs in through your editor, which has no account for ${remote.host}. ` +
          `Set \`github-enterprise.uri\` to \`https://${remote.host}\` and sign in to GitHub Enterprise.`
      };
    }

    const api = this.apiFor(remote);
    try {
      const { login, nameWithOwner } = await api.probe();
      this.api = api;
      return { kind: 'ok', login, nameWithOwner };
    } catch (error) {
      return toState(error);
    }
  }

  async listPullRequests(limit: number, includeDrafts: boolean): Promise<PullRequest[]> {
    if (!this.api) {
      throw new GitHubApiError('signed-out', 'Sign in to GitHub to see open pull requests.');
    }
    return this.api.listPullRequests(limit, includeDrafts);
  }

  /** Which host this repository's pull requests live on, for the sign-in command. */
  async host(): Promise<string | undefined> {
    return (await this.resolveRemote())?.host;
  }

  /**
   * Where a pull request lives on the web, without asking anyone.
   *
   * The stored record carries a url for every pull request GitRay has seen, so this is only
   * for the ones it has not — a number typed into the palette, or one that closed while the
   * sidebar was open. Deriving it from the remote beats a request for a redirect.
   */
  async pullRequestUrl(prNumber: number): Promise<string | undefined> {
    const remote = await this.resolveRemote();
    if (!remote) return undefined;
    return `https://${remote.host}/${remote.nameWithOwner}/pull/${prNumber}`;
  }

  private apiFor(remote: RemoteRepository): GitHubApi {
    // One client per remote, so the token source is consulted per request rather than per
    // repository — a session that expires mid-session is then noticed on the next poll.
    return new GitHubApi(remote, this.tokens);
  }

  /**
   * The repository the selected remote points at.
   *
   * Keyed on the selected remote rather than read once and kept forever. `gitray.remote` is
   * a live setting: repoint it mid-session and the sync engine starts fetching refs from
   * somewhere new, so a repository cached from the old one would leave this client listing
   * pull requests from a repository the refs no longer come from. The engine re-probes on
   * the same signal, which is what rebuilds the API client underneath.
   */
  private async resolveRemote(): Promise<RemoteRepository | undefined> {
    const name = await this.remotes.name();
    if (this.remoteRead && name === this.remoteName) return this.remote;
    this.remoteRead = true;
    this.remoteName = name;

    this.remote = await this.remotes.repository();
    if (this.remote) {
      log.debug(`remote resolves to ${this.remote.nameWithOwner} on ${this.remote.host}`);
    } else {
      log.debug('no remote here looks like a GitHub repository');
    }
    return this.remote;
  }
}

/**
 * Turn an API failure into the state the UI reasons about.
 *
 * Exported because a session can expire between one poll and the next: the sync engine
 * translates a mid-flight failure the same way it translates a failed probe, so the
 * sidebar offers the sign-in row rather than an exception.
 */
export function toState(error: unknown): GitHubFailure {
  if (error instanceof GitHubApiError) {
    switch (error.kind) {
      case 'signed-out':
        // The message is already written for the user: the API layer knows whether this is
        // a first run with no session or a token that stopped working, and those read
        // differently to someone who thought they were signed in.
        return { kind: 'signed-out', canSignIn: true, message: error.message };
      case 'no-repo':
        return { kind: 'no-repo', message: error.message };
      case 'offline':
        return { kind: 'offline', message: error.message };
    }
  }
  return { kind: 'offline', message: error instanceof Error ? error.message : String(error) };
}

/**
 * The one place that decides how GitRay talks to GitHub.
 *
 * Two transports answer the same question. The `gh` CLI is preferred whenever it is
 * installed and logged in: it costs GitRay no permission at all, and it already understands
 * Enterprise hosts, fork base repositories, and whatever host config the user has set. When
 * gh is absent or logged out, the editor's own GitHub session is asked instead, which is
 * what removes the "install a CLI first" step from a fresh install.
 *
 * The fallback is deliberately narrower than the CLI. It speaks only to github.com, because
 * that is the only host the editor's built-in provider issues tokens for, and it works out
 * which repository to ask about from `origin` rather than from gh's base-repo resolution.
 * Where gh has a real answer — including "there is no GitHub repository here" — that answer
 * wins, because it is better informed than anything this module can derive.
 */

import { log } from '../core/log.js';
import type { PullRequest } from '../core/types.js';
import { Gh } from './gh.js';
import type { Git } from './git.js';
import { GitHubApi, GitHubApiError, type TokenSource } from './githubApi.js';
import { isGitHubDotCom, parseRemoteUrl, type RemoteRepository } from './remote.js';

export type Transport = 'cli' | 'api';

export type GitHubState =
  | { kind: 'ok'; login: string; nameWithOwner: string; transport: Transport }
  /** No usable credentials. `canSignIn` is whether the editor's sign-in would help. */
  | { kind: 'signed-out'; message: string; canSignIn: boolean }
  | { kind: 'offline'; message: string }
  | { kind: 'no-repo'; message: string };

/** Every state except success, which is the only one the UI has to explain. */
export type GitHubFailure = Exclude<GitHubState, { kind: 'ok' }>;

export class GitHub {
  private transport: Transport | undefined;
  private api: GitHubApi | undefined;
  private remote: RemoteRepository | undefined;
  private remoteRead = false;

  constructor(
    root: string,
    private readonly git: Git,
    private readonly tokens: TokenSource,
    /** Injectable so the transport choice can be exercised on a machine that has gh. */
    private readonly cli: Gh = new Gh(root)
  ) {}

  /** Which transport the last successful probe settled on, for the log and the UI. */
  get activeTransport(): Transport | undefined {
    return this.transport;
  }

  /** Work out whether we can talk to GitHub at all, and as whom. */
  async probe(): Promise<GitHubState> {
    // Forgotten first, so a transport that stopped working cannot be remembered as the
    // active one. Anything that reads `transport` — checkout, above all — would otherwise
    // keep believing in a gh that has since been logged out.
    this.transport = undefined;

    const viaCli = await this.probeCli();
    if (viaCli) return viaCli;
    return this.probeApi();
  }

  /**
   * Undefined means "gh cannot answer, ask the editor" — it is missing, or logged out.
   *
   * Everything else gh reports is returned as final. An offline gh means the network is
   * down for the API too, and a gh that resolved the folder to no GitHub repository knows
   * more about the remotes here than a parsed `origin` URL does.
   */
  private async probeCli(): Promise<GitHubState | undefined> {
    const state = await this.cli.probe();
    switch (state.kind) {
      case 'ok':
        this.transport = 'cli';
        return { ...state, transport: 'cli' };
      case 'offline':
        return { kind: 'offline', message: state.message };
      case 'no-repo':
        return { kind: 'no-repo', message: state.message };
      case 'missing':
      case 'unauthenticated':
        return undefined;
    }
  }

  private async probeApi(): Promise<GitHubState> {
    const remote = await this.resolveRemote();
    if (!remote) {
      return {
        kind: 'no-repo',
        message: 'This folder has no `origin` remote pointing at a GitHub repository.'
      };
    }

    if (!isGitHubDotCom(remote)) {
      return {
        kind: 'signed-out',
        canSignIn: false,
        message: `GitRay can sign in to github.com by itself, but ${remote.host} needs the GitHub CLI — install \`gh\` and run \`gh auth login\`.`
      };
    }

    const api = this.apiFor(remote);
    try {
      const { login, nameWithOwner } = await api.probe();
      this.transport = 'api';
      this.api = api;
      return { kind: 'ok', login, nameWithOwner, transport: 'api' };
    } catch (error) {
      return toState(error);
    }
  }

  async listPullRequests(limit: number, includeDrafts: boolean): Promise<PullRequest[]> {
    if (this.transport === 'api' && this.api) {
      return this.api.listPullRequests(limit, includeDrafts);
    }
    return this.cli.listPullRequests(limit, includeDrafts);
  }

  /**
   * Where a pull request lives on the web, without asking anyone.
   *
   * The stored record carries a url for every pull request GitRay has seen, so this is only
   * for the ones it has not — a number typed into the palette, or one that closed while the
   * sidebar was open. Deriving it from the remote beats shelling out to gh for a redirect.
   */
  pullRequestUrl(prNumber: number): string | undefined {
    if (!this.remote) return undefined;
    return `https://${this.remote.host}/${this.remote.nameWithOwner}/pull/${prNumber}`;
  }

  /** Open the pull request in the user's browser, via gh so it respects their host config. */
  async openInBrowser(prNumber: number): Promise<void> {
    await this.cli.openInBrowser(prNumber);
  }

  /**
   * Check out a pull request branch.
   *
   * gh only, and knowingly so. Fork heads have no branch on `origin` to switch to, and gh
   * is what configures the branch so a later `git push` reaches the contributor's
   * repository — a local branch cut from GitRay's read-only ref would look identical and
   * push to the wrong place. Callers check `canCheckout` first and say so plainly.
   */
  async checkout(prNumber: number): Promise<void> {
    await this.cli.checkout(prNumber);
  }

  /**
   * Whether `checkout` would actually work.
   *
   * Installed is not enough, and the difference is a state the fallback made reachable:
   * gh present but logged out, with the editor's session carrying the extension. Asking
   * only about the executable would let the command past this gate and fail a moment later
   * with gh's raw stderr in a notification, instead of the sentence that names the fix.
   *
   * A settled transport already answers this — `cli` means a gh probe succeeded — so the
   * common paths cost nothing. The probe is only paid before the first sync has finished.
   */
  async canCheckout(): Promise<boolean> {
    if (this.transport) return this.transport === 'cli';
    return (await this.cli.probe()).kind === 'ok';
  }

  private apiFor(remote: RemoteRepository): GitHubApi {
    // One client per remote, so the token source is consulted per request rather than per
    // repository — a session that expires mid-session is then noticed on the next poll.
    return new GitHubApi(remote, this.tokens);
  }

  /** Read `origin` once. It cannot change without a reload that rebuilds this object. */
  private async resolveRemote(): Promise<RemoteRepository | undefined> {
    if (this.remoteRead) return this.remote;
    this.remoteRead = true;

    const url = await this.git.remoteUrl();
    this.remote = url ? parseRemoteUrl(url) : undefined;
    if (this.remote) {
      log.debug(`origin resolves to ${this.remote.nameWithOwner} on ${this.remote.host}`);
    } else if (url) {
      log.debug('origin does not look like a GitHub repository');
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

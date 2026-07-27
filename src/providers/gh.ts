/**
 * GitHub metadata via the user's own `gh` CLI.
 *
 * The preferred of GitRay's two transports, because it needs no permission GitRay has to
 * ask for: `gh` already holds the user's credentials, already knows about Enterprise hosts
 * and fork base repositories, and already respects whatever host config they have set. When
 * it is absent, `GitHub` falls back to the editor's own session — see github.ts.
 *
 * It fetches metadata only; every byte of file content comes from local git.
 */

import { run, isAvailable, CommandError } from '../core/exec.js';
import type { PullRequest } from '../core/types.js';
import {
  OVERFETCH,
  PR_FIELDS,
  toPullRequests,
  type RawPullRequest
} from './pullRequestFields.js';

export type GhState =
  | { kind: 'ok'; login: string; nameWithOwner: string }
  | { kind: 'missing' }
  | { kind: 'unauthenticated' }
  | { kind: 'offline'; message: string }
  | { kind: 'no-repo'; message: string };

export class Gh {
  constructor(private readonly cwd: string) {}

  private async gh(args: string[]): Promise<string> {
    const result = await run('gh', args, { cwd: this.cwd, timeout: 45_000 });
    return result.stdout;
  }

  /** Is the CLI on PATH at all? Cheap, and the answer decides which transport is used. */
  isInstalled(): Promise<boolean> {
    return isAvailable('gh', this.cwd);
  }

  /** Work out whether we can talk to GitHub at all, and as whom. */
  async probe(): Promise<GhState> {
    if (!(await this.isInstalled())) {
      return { kind: 'missing' };
    }

    let login: string;
    try {
      login = (await this.gh(['api', 'user', '--jq', '.login'])).trim();
      if (!login) return { kind: 'unauthenticated' };
    } catch (error) {
      return classifyProbeFailure(error);
    }

    try {
      const nameWithOwner = (
        await this.gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
      ).trim();
      if (!nameWithOwner) {
        return { kind: 'no-repo', message: 'No GitHub repository is associated with this folder.' };
      }
      return { kind: 'ok', login, nameWithOwner };
    } catch (error) {
      const message =
        error instanceof CommandError
          ? error.stderr.trim().split('\n')[0] || error.message
          : String(error);
      return { kind: 'no-repo', message };
    }
  }

  /**
   * Open pull requests, most recently updated first.
   *
   * One request regardless of how many pull requests are open — the `files` field comes
   * back in the same payload, which is what makes file-level indicators available before
   * any local diffing happens.
   */
  async listPullRequests(limit: number, includeDrafts: boolean): Promise<PullRequest[]> {
    const args = [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      String(Math.max(limit, OVERFETCH)),
      '--json',
      PR_FIELDS.join(',')
    ];

    const raw = JSON.parse(await this.gh(args)) as RawPullRequest[];
    return toPullRequests(raw, limit, includeDrafts);
  }

  /** Open the pull request in the user's browser, via gh so it respects their host config. */
  async openInBrowser(prNumber: number): Promise<void> {
    await this.gh(['pr', 'view', String(prNumber), '--web']);
  }

  /**
   * Check out the pull request's branch via gh rather than raw git: gh resolves fork
   * heads, which do not exist as branches on `origin`, and configures the branch so a
   * later `git push` goes back to the contributor's repository.
   */
  async checkout(prNumber: number): Promise<void> {
    await this.gh(['pr', 'checkout', String(prNumber)]);
  }
}

/**
 * Decide what a failed `gh api user` means.
 *
 * Being logged out and being offline both surface here, and they need different advice:
 * telling someone on a plane to run `gh auth login` sends them debugging credentials that
 * are fine. gh reports missing auth before touching the network, with a message that
 * names the fix, so anything else — DNS, timeouts, proxies — is treated as connectivity.
 */
function classifyProbeFailure(error: unknown): GhState {
  if (error instanceof CommandError) {
    if (/HTTP 401|Unauthorized|not logged in|authentication token|gh auth login/i.test(error.stderr)) {
      return { kind: 'unauthenticated' };
    }
    return {
      kind: 'offline',
      message: error.stderr.trim().split('\n')[0] || 'GitHub could not be reached.'
    };
  }
  return { kind: 'offline', message: String(error) };
}

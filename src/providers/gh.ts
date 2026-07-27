/**
 * GitHub metadata via the user's own `gh` CLI.
 *
 * This is the only part of GitRay that talks to the network, and it does so through the
 * credentials already on the machine — no token handling, no server of ours in the path.
 * It fetches metadata only; every byte of file content comes from local git.
 */

import { run, isAvailable, CommandError } from '../core/exec.js';
import type { PullRequest, PullRequestFile } from '../core/types.js';

export type GhState =
  | { kind: 'ok'; login: string; nameWithOwner: string }
  | { kind: 'missing' }
  | { kind: 'unauthenticated' }
  | { kind: 'offline'; message: string }
  | { kind: 'no-repo'; message: string };

interface RawAuthor {
  login?: string;
}

interface RawFile {
  path?: string;
  additions?: number;
  deletions?: number;
}

interface RawPullRequest {
  number?: number;
  title?: string;
  author?: RawAuthor | null;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  isDraft?: boolean;
  updatedAt?: string;
  url?: string;
  additions?: number;
  deletions?: number;
  files?: RawFile[] | null;
}

const PR_FIELDS = [
  'number',
  'title',
  'author',
  'headRefName',
  'headRefOid',
  'baseRefName',
  'isDraft',
  'updatedAt',
  'url',
  'additions',
  'deletions',
  'files'
].join(',');

/**
 * How many pull requests to ask for before trimming.
 *
 * `gh pr list` returns newest-created first and has no sort flag, so asking for exactly
 * the configured maximum could miss an old pull request that someone pushed to this
 * morning. Over-fetching and sorting by updatedAt locally costs nothing extra — it is
 * still one request — and gets the genuinely active ones.
 */
const OVERFETCH = 100;

export class Gh {
  constructor(private readonly cwd: string) {}

  private async gh(args: string[]): Promise<string> {
    const result = await run('gh', args, { cwd: this.cwd, timeout: 45_000 });
    return result.stdout;
  }

  /** Work out whether we can talk to GitHub at all, and as whom. */
  async probe(): Promise<GhState> {
    if (!(await isAvailable('gh', this.cwd))) {
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
      PR_FIELDS
    ];

    const raw = JSON.parse(await this.gh(args)) as RawPullRequest[];

    return raw
      .filter((pr) => typeof pr.number === 'number' && typeof pr.headRefOid === 'string')
      .map(toPullRequest)
      .filter((pr) => includeDrafts || !pr.isDraft)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit);
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

function toPullRequest(raw: RawPullRequest): PullRequest {
  const files: PullRequestFile[] = (raw.files ?? [])
    .filter((file): file is RawFile & { path: string } => typeof file.path === 'string')
    .map((file) => ({
      path: file.path,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0
    }));

  return {
    number: raw.number as number,
    title: raw.title?.trim() || '(no title)',
    // A deleted account shows up with a null author; "ghost" is what GitHub itself calls it.
    author: raw.author?.login ?? 'ghost',
    headRefName: raw.headRefName ?? '',
    headRefOid: raw.headRefOid as string,
    baseRefName: raw.baseRefName ?? '',
    isDraft: raw.isDraft === true,
    updatedAt: raw.updatedAt ?? new Date(0).toISOString(),
    url: raw.url ?? '',
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    files
  };
}

/**
 * The pull request metadata GitRay asks for, and how it lands in the model.
 *
 * Two transports fetch it — the `gh` CLI and the GraphQL API directly — and they return
 * the same fields, because `gh pr list --json` is a thin wrapper over the same query. The
 * shape and its mapping live here so the two cannot drift into disagreeing about what a
 * missing author or an untitled pull request means.
 */

import { MAX_TRACKED_PULL_REQUESTS, type PullRequest, type PullRequestFile } from '../core/types.js';

export const PR_FIELDS = [
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
] as const;

/**
 * How many pull requests to ask for before trimming.
 *
 * `gh pr list` returns newest-created first and has no sort flag, so asking for exactly
 * the configured maximum could miss an old pull request that someone pushed to this
 * morning. Over-fetching and sorting by updatedAt locally costs nothing extra — it is
 * still one request — and gets the genuinely active ones. The GraphQL path can sort
 * server-side, but it over-fetches to the same depth so that both transports answer a
 * given repository identically, drafts and all — which is only true while this is exactly
 * the page both of them are limited to.
 */
export const OVERFETCH = MAX_TRACKED_PULL_REQUESTS;

export interface RawFile {
  path?: string;
  additions?: number;
  deletions?: number;
}

export interface RawPullRequest {
  number?: number;
  title?: string;
  author?: { login?: string } | null;
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

export function toPullRequest(raw: RawPullRequest): PullRequest {
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

/**
 * Trim a raw response to the pull requests worth showing, most recently updated first.
 *
 * Records without a number or a head commit are dropped rather than defaulted: both are
 * how GitRay names a pull request to git, and a placeholder for either would produce
 * indicators computed against nothing.
 */
export function toPullRequests(
  raw: readonly RawPullRequest[],
  limit: number,
  includeDrafts: boolean
): PullRequest[] {
  return raw
    .filter((pr) => typeof pr.number === 'number' && typeof pr.headRefOid === 'string')
    .map(toPullRequest)
    .filter((pr) => includeDrafts || !pr.isDraft)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}

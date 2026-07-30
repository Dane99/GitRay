/**
 * The pull request metadata GitRay asks for, and how it lands in the model.
 *
 * GitHub's answer is a loose bag of optionals — a deleted account has no author, a deleted
 * fork has no head repository — and every surface downstream wants a definite record. The
 * mapping lives here alone so there is one place that decides what a missing field means.
 */

import { MAX_TRACKED_PULL_REQUESTS, type PullRequest, type PullRequestFile } from '../core/types.js';

/**
 * How many pull requests to ask for before trimming.
 *
 * Drafts are filtered after the response arrives, and the muted ones after that, so asking
 * for exactly the configured maximum would let a handful of drafts push real pull requests
 * off the end of the list. Over-fetching to the page limit costs nothing extra — it is
 * still one request — and makes the answer depend on the repository rather than on how
 * many of its open pull requests happen to be hidden.
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
  isCrossRepository?: boolean;
  maintainerCanModify?: boolean;
  /** Null when the fork the branch lived in has since been deleted. */
  headRepository?: { url?: string } | null;
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
    isCrossRepository: raw.isCrossRepository === true,
    maintainerCanModify: raw.maintainerCanModify === true,
    headRepositoryUrl: raw.headRepository?.url || undefined,
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

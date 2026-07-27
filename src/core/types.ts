/**
 * Shared vocabulary for GitRay.
 *
 * A note on coordinates, because it is the single easiest thing to get wrong here:
 *
 *  - "base" coordinates are line numbers in the file as it exists at the shared ancestor
 *    both sides edited away from — the merge base with a collaborator's pull request head,
 *    or the commit where your branch left the mainline. This is the coordinate system git
 *    itself uses when deciding whether two changes conflict.
 *  - "buffer" coordinates are line numbers in the document you are looking at right now,
 *    including unsaved edits.
 *
 * Conflict detection happens in base coordinates. Rendering happens in buffer
 * coordinates. Anything that mixes the two is a bug.
 *
 * All line numbers in this file are 0-based and all ranges are half-open [start, end),
 * so an empty range start === end represents a pure insertion point.
 */

/** A half-open line range, 0-based. `start === end` means an insertion point. */
export interface LineRange {
  start: number;
  end: number;
}

/** The ref namespace-free name of the branch GitRay treats as the mainline, e.g. `main`. */
export type BranchName = string;

/** What a change did to the base text. */
export type ChangeKind = 'add' | 'modify' | 'delete';

/** How a collaborator's change relates to your own uncommitted work. */
export type Severity = 'ambient' | 'nearMiss' | 'collision';

/** Pull request metadata, as reported by `gh pr list`. */
export interface PullRequest {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isDraft: boolean;
  updatedAt: string;
  url: string;
  additions: number;
  deletions: number;
  /** Repo-relative POSIX paths this PR touches, from the cheap file-level index. */
  files: PullRequestFile[];
}

export interface PullRequestFile {
  path: string;
  additions: number;
  deletions: number;
}

/** One commit that landed on the mainline since your branch left it. */
export interface MainlineCommit {
  /** Abbreviated sha, as git prints it. */
  sha: string;
  author: string;
  subject: string;
  /** ISO 8601, author date. */
  date: string;
  /**
   * The pull request this commit closed, when the subject still says so.
   *
   * GitHub's squash merges end the subject with `(#123)` and its merge commits begin with
   * `Merge pull request #123`, so the number usually survives the merge and the change can
   * still be linked back to the discussion that produced it. Absent for a direct push.
   */
  prNumber?: number;
}

/**
 * Where a change came from.
 *
 * Two kinds, and the difference is the whole point of tracking the second one:
 *
 *  - `pullRequest` is a *forecast*. Someone is working here and has not landed yet, so
 *    the overlap is still hypothetical and either of you can move.
 *  - `mainline` is *history*. It already merged, so the overlap is not a prediction — it
 *    is waiting for you at your next rebase, and only you can resolve it.
 */
export type ChangeOrigin =
  | { kind: 'pullRequest'; prNumber: number }
  | {
      kind: 'mainline';
      branch: BranchName;
      /** What landed on this file, newest first. Empty when the log could not be read. */
      commits: readonly MainlineCommit[];
    };

/** The pull request a region belongs to, or undefined for mainline drift. */
export function prNumberOf(origin: ChangeOrigin): number | undefined {
  return origin.kind === 'pullRequest' ? origin.prNumber : undefined;
}

/**
 * Tie-break order for two regions that start on the same line.
 *
 * The mainline leads, matching every other surface: what has already landed outranks what
 * might. Pull requests then order by number *numerically* — comparing the origin keys as
 * strings would put #10 before #9.
 */
export function compareOrigins(a: ChangeOrigin, b: ChangeOrigin): number {
  if (a.kind === 'mainline') {
    return b.kind === 'mainline' ? a.branch.localeCompare(b.branch) : -1;
  }
  if (b.kind === 'mainline') return 1;
  return a.prNumber - b.prNumber;
}

/**
 * Stable identity for an origin, for cache keys and change detection.
 *
 * Mainline regions collapse to one key per branch: their content is pinned by the base and
 * tip shas that callers already fold into their own keys, so repeating it here would only
 * make the strings longer.
 */
export function originKey(origin: ChangeOrigin): string {
  return origin.kind === 'pullRequest' ? `pr:${origin.prNumber}` : `mainline:${origin.branch}`;
}

/**
 * One contiguous edit someone else made, expressed against a base commit.
 *
 * `baseRange` is where the change lands in the base file. For a pure addition it is empty
 * (start === end), marking the seam the new lines were inserted into.
 *
 * Which base that is depends on the origin: a pull request's regions are in the merge base
 * between your HEAD and its head, while mainline regions are in the commit where your
 * branch left the mainline. Both are recorded in `baseSha`, and both are compared against
 * your own edits expressed in that same commit's coordinates.
 */
export interface ChangeRegion {
  origin: ChangeOrigin;
  /**
   * Who to credit. The pull request's author, or — for mainline drift — the author of the
   * commit that landed, falling back to the branch name when several people contributed.
   */
  author: string;
  /** Base commit these coordinates belong to. */
  baseSha: string;
  baseRange: LineRange;
  kind: ChangeKind;
  /** Lines removed from the base text. */
  removed: string[];
  /** Lines put there instead. */
  added: string[];
}

/** A change region resolved into the current buffer, ready to render. */
export interface ResolvedRegion extends ChangeRegion {
  /** Where to draw, in buffer coordinates. */
  range: LineRange;
  severity: Severity;
  /** Your own overlapping edit, in base coordinates, when there is one. */
  overlapsWith?: LineRange;
  /** Distance in lines to your nearest edit; 0 when they touch or overlap. */
  distance: number;
}

/** Per-file line-level analysis for one document. */
export interface FileAnalysis {
  /** Repo-relative POSIX path. */
  path: string;
  regions: ResolvedRegion[];
  /** True when the file exceeded a cap and only a file-level indicator is available. */
  degraded: boolean;
}

/** File-level summary, available without any line-level work. */
export interface FileSummary {
  path: string;
  prNumbers: number[];
  authors: string[];
  additions: number;
  deletions: number;
}

/**
 * Where the mainline is, as of the last time GitRay looked.
 *
 * `tip` is what the branch points at on the remote; `base` is where your branch left it.
 * When the two differ, work has landed that you have not rebased onto yet — which is the
 * whole reason this is tracked.
 */
export interface MainlineState {
  branch: BranchName;
  tip: string;
  base: string;
  /** Commits between `base` and `tip`, newest first. Capped at MAX_LOGGED_COMMITS. */
  commits: readonly MainlineCommit[];
}

/**
 * How many commits are reported for a range.
 *
 * A branch left alone over a holiday can be hundreds behind, and nobody reads past the
 * first handful. The cap is part of the contract of `MainlineState.commits`, which is why
 * it lives here rather than with the git call that applies it.
 */
export const MAX_LOGGED_COMMITS = 20;

/**
 * How many open pull requests a single refresh can see.
 *
 * GitHub's GraphQL connections page at 100 and GitRay does not paginate: the promise that a
 * refresh costs one request is worth more than the hundred-and-first pull request, which no
 * editor surface could say anything useful about anyway.
 *
 * It lives here because it binds three things that must agree — how deep the CLI transport
 * over-fetches, what the API transport asks for, and the ceiling `gitray.maxPullRequests`
 * is clamped to. Letting them drift is how the same repository comes to show a different
 * number of pull requests on two machines.
 */
export const MAX_TRACKED_PULL_REQUESTS = 100;

/**
 * How far behind the mainline is, in the form every surface needs.
 *
 * `count` hitting the cap means the real number is *at least* that, so `display` says
 * `20+`. Stating a capped count as exact is the kind of quiet lie that erodes trust in
 * everything else on the screen, and it is easy to do by accident — hence one helper
 * rather than the same conditional copied onto four surfaces.
 */
export interface BehindMainline {
  count: number;
  /** True when `count` is really a floor, because the log hit its cap. */
  capped: boolean;
  /** The count as it should be shown: `12`, or `20+` when truncated. */
  display: string;
}

export function behindMainline(state: MainlineState | undefined): BehindMainline {
  const count = state && state.tip !== state.base ? state.commits.length : 0;
  const capped = count >= MAX_LOGGED_COMMITS;
  return { count, capped, display: capped ? `${count}+` : String(count) };
}

/** Why line-level indicators are unavailable, when they are. */
export type DegradedReason =
  /** No GitHub credentials, and the editor's own sign-in would supply them. */
  | 'signed-out'
  /** No GitHub credentials, and only the `gh` CLI can supply them — an Enterprise host. */
  | 'gh-required'
  | 'not-a-repo'
  | 'no-remote'
  | 'fetch-failed'
  | 'fetch-disabled'
  | 'offline';

export interface StatusInfo {
  state: 'idle' | 'ready' | 'degraded' | 'error';
  /** Present when state is 'degraded' or 'error'. */
  reason?: DegradedReason;
  message?: string;
  lastSync?: number;
  pullRequestCount: number;
}

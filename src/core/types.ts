/**
 * Shared vocabulary for GitRay.
 *
 * A note on coordinates, because it is the single easiest thing to get wrong here:
 *
 *  - "base" coordinates are line numbers in the file as it exists at the merge base
 *    between your HEAD and a collaborator's pull request head. This is the shared
 *    ancestor both of you edited away from, and it is the coordinate system git itself
 *    uses when deciding whether two changes conflict.
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

/** What a change did to the base text. */
export type ChangeKind = 'add' | 'modify' | 'delete';

/** How a collaborator's change relates to your own uncommitted work. */
export type Severity = 'ambient' | 'nearMiss' | 'collision';

/** Pull request metadata, as reported by `gh pr list`. */
export interface PullRequest {
  number: number;
  title: string;
  author: string;
  authorIsBot: boolean;
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

/**
 * One contiguous edit a collaborator made, expressed against the merge base.
 *
 * `baseRange` is where the change lands in the merge-base file. For a pure addition it
 * is empty (start === end), marking the seam the new lines were inserted into.
 */
export interface ChangeRegion {
  prNumber: number;
  author: string;
  /** Merge base commit these coordinates belong to. */
  baseSha: string;
  baseRange: LineRange;
  kind: ChangeKind;
  /** Lines removed from the base text. */
  removed: string[];
  /** Lines the collaborator put there instead. */
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

/** Why line-level indicators are unavailable, when they are. */
export type DegradedReason =
  | 'gh-missing'
  | 'gh-unauthenticated'
  | 'not-a-repo'
  | 'no-remote'
  | 'fetch-failed'
  | 'fetch-disabled'
  | 'offline';

export interface StatusInfo {
  state: 'idle' | 'syncing' | 'ready' | 'degraded' | 'error';
  /** Present when state is 'degraded' or 'error'. */
  reason?: DegradedReason;
  message?: string;
  lastSync?: number;
  pullRequestCount: number;
}

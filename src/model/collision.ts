/**
 * Conflict prediction.
 *
 * The rule mirrors what git's 3-way merge actually does: two changes conflict when their
 * touched ranges in the common ancestor overlap *or are adjacent*. Adjacency counts —
 * git will not silently interleave two edits that meet at a seam, it stops and asks. So
 * a zero-line gap is a collision, not a near miss.
 *
 * Everything here works in base (merge-base) coordinates. Passing buffer coordinates in
 * would produce confident nonsense.
 */

import type { LineRange, Severity } from '../core/types.js';

export interface Proximity {
  severity: Severity;
  /** Lines between the two ranges. 0 when they overlap or touch. */
  distance: number;
  /** The local edit responsible for the verdict, when there is one. */
  nearest?: LineRange;
}

/** Do these two half-open ranges share at least one line? */
export function overlaps(a: LineRange, b: LineRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Lines separating two ranges; 0 when they overlap or touch.
 *
 * Empty ranges (insertion points) work out correctly: an insertion at the seam where
 * your edit begins yields distance 0, which is right — git cannot order two edits that
 * both claim the same seam.
 */
export function gap(a: LineRange, b: LineRange): number {
  if (overlaps(a, b)) return 0;
  if (a.end <= b.start) return b.start - a.end;
  return a.start - b.end;
}

/**
 * Classify a collaborator's change against your local edits.
 *
 * `proximityLines` is the near-miss window: how close their work can come to yours
 * before it is worth mentioning. A gap of 0 is always a collision regardless.
 */
export function classifyProximity(
  theirs: LineRange,
  localEdits: readonly LineRange[],
  proximityLines: number
): Proximity {
  if (localEdits.length === 0) {
    return { severity: 'ambient', distance: Number.POSITIVE_INFINITY };
  }

  let best = Number.POSITIVE_INFINITY;
  let nearest: LineRange | undefined;

  for (const local of localEdits) {
    const distance = gap(theirs, local);
    if (distance < best) {
      best = distance;
      nearest = local;
      if (best === 0) break;
    }
  }

  if (best === 0) {
    return { severity: 'collision', distance: 0, nearest };
  }
  if (best <= proximityLines) {
    return { severity: 'nearMiss', distance: best, nearest };
  }
  return { severity: 'ambient', distance: best, nearest };
}

const RANK: Record<Severity, number> = { ambient: 0, nearMiss: 1, collision: 2 };

export function maxSeverity(severities: readonly Severity[]): Severity {
  let best: Severity = 'ambient';
  for (const severity of severities) {
    if (RANK[severity] > RANK[best]) best = severity;
  }
  return best;
}

export function isAtLeast(severity: Severity, floor: Severity): boolean {
  return RANK[severity] >= RANK[floor];
}

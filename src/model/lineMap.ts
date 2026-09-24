/**
 * Alignment between the merge-base version of a file and the buffer you are editing.
 *
 * This does two jobs at once, from a single diff:
 *
 *   1. It reports *your* changed line ranges in base coordinates, which is the input
 *      conflict detection needs.
 *   2. It maps a collaborator's base coordinates into your buffer, so their indicator
 *      stays anchored to the right lines as you type above it.
 */

import { diffArrays } from 'diff';
import type { LineRange } from '../core/types.js';

/** A run of lines that is identical on both sides. */
interface EqualSegment {
  base: number;
  buffer: number;
  length: number;
}

/** A run of lines that differs, with its extent on each side. */
interface ChangedSegment {
  baseStart: number;
  baseEnd: number;
  bufferStart: number;
  bufferEnd: number;
}

export interface Alignment {
  /** Your edits, in base coordinates. Empty when your file matches the merge base. */
  localEdits: LineRange[];
  /** The same edits, in buffer coordinates. */
  bufferEdits: LineRange[];
  baseLineCount: number;
  bufferLineCount: number;
  /** True when the two sides are identical. */
  clean: boolean;
  /** Map a base line into the buffer. */
  toBuffer(baseLine: number): number;
  /** Map a base range into the buffer, preserving insertion points as empty ranges. */
  toBufferRange(range: LineRange): LineRange;
  /**
   * Map a buffer range back into base coordinates.
   *
   * Needed to express a range discovered against one commit in terms of another: your
   * own edits are found against the mainline, but conflicts must be judged in the
   * merge base's coordinate system.
   */
  toBaseRange(range: LineRange): LineRange;
}

/** Split text into lines the same way VS Code counts them, EOL style aside. */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * Limits on how much work one alignment may do.
 *
 * Myers' algorithm costs roughly (N + M) × D, where D is the number of differing lines, so
 * a large file that has drifted far from its base is quadratic: 10,000 lines with a third
 * of them changed takes seconds, all of it on the extension host's only thread. Past these
 * limits the alignment is abandoned and the file falls back to a file-level indicator,
 * which is the honest answer for a file that has been rewritten anyway.
 */
export interface AlignmentLimits {
  /** Differing lines beyond which the diff gives up. */
  maxEditLength: number;
  /** Milliseconds beyond which the diff gives up. */
  timeoutMs: number;
}

export const DEFAULT_ALIGNMENT_LIMITS: AlignmentLimits = { maxEditLength: 4000, timeoutMs: 250 };

type Part = { count?: number; value: string[]; added?: boolean; removed?: boolean };

/**
 * Diff two line arrays, or give up when it would cost more than `limits` allow.
 *
 * The common prefix and suffix are stripped first. Myers walks them for free in principle,
 * but in practice a typical edit touches a few lines in the middle of a long file, and
 * trimming means the expensive part only ever sees those lines.
 */
function diffLines(
  baseLines: string[],
  bufferLines: string[],
  limits: AlignmentLimits | undefined
): Part[] | undefined {
  const shorter = Math.min(baseLines.length, bufferLines.length);
  let prefix = 0;
  while (prefix < shorter && baseLines[prefix] === bufferLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    baseLines[baseLines.length - 1 - suffix] === bufferLines[bufferLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const baseMiddle = baseLines.slice(prefix, baseLines.length - suffix);
  const bufferMiddle = bufferLines.slice(prefix, bufferLines.length - suffix);

  let middle: Part[];
  if (baseMiddle.length === 0 && bufferMiddle.length === 0) {
    middle = [];
  } else if (baseMiddle.length === 0) {
    middle = [{ count: bufferMiddle.length, value: bufferMiddle, added: true }];
  } else if (bufferMiddle.length === 0) {
    middle = [{ count: baseMiddle.length, value: baseMiddle, removed: true }];
  } else {
    const options = limits
      ? { maxEditLength: limits.maxEditLength, timeout: limits.timeoutMs }
      : undefined;
    const result = diffArrays(baseMiddle, bufferMiddle, options as never) as Part[] | undefined;
    if (!result) return undefined;
    middle = result;
  }

  const parts: Part[] = [];
  if (prefix > 0) parts.push({ count: prefix, value: [] });
  parts.push(...middle);
  if (suffix > 0) parts.push({ count: suffix, value: [] });
  return parts;
}

/** Align without limits. Always produces an answer, however long it takes. */
export function alignLines(baseLines: string[], bufferLines: string[]): Alignment {
  return alignLinesWithin(baseLines, bufferLines, undefined) as Alignment;
}

/** Align, or return undefined when the two sides are too far apart to be worth it. */
export function alignLinesWithin(
  baseLines: string[],
  bufferLines: string[],
  limits: AlignmentLimits | undefined = DEFAULT_ALIGNMENT_LIMITS
): Alignment | undefined {
  const parts = diffLines(baseLines, bufferLines, limits);
  if (!parts) return undefined;

  const equals: EqualSegment[] = [];
  const changes: ChangedSegment[] = [];
  const localEdits: LineRange[] = [];

  let baseIdx = 0;
  let bufferIdx = 0;

  for (let i = 0; i < parts.length; ) {
    const part = parts[i];
    const count = part.count ?? part.value.length;

    if (!part.added && !part.removed) {
      if (count > 0) {
        equals.push({ base: baseIdx, buffer: bufferIdx, length: count });
      }
      baseIdx += count;
      bufferIdx += count;
      i++;
      continue;
    }

    // Coalesce a run of adjacent added/removed parts into one edit. jsdiff emits a
    // modification as a removed part followed by an added part; treating them separately
    // would report two edits where the user made one.
    const baseStart = baseIdx;
    const bufferStart = bufferIdx;
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const runCount = parts[i].count ?? parts[i].value.length;
      if (parts[i].removed) baseIdx += runCount;
      else bufferIdx += runCount;
      i++;
    }

    changes.push({ baseStart, baseEnd: baseIdx, bufferStart, bufferEnd: bufferIdx });
    localEdits.push({ start: baseStart, end: baseIdx });
  }

  const findEqual = (baseLine: number): EqualSegment | undefined => {
    let lo = 0;
    let hi = equals.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = equals[mid];
      if (baseLine < seg.base) hi = mid - 1;
      else if (baseLine >= seg.base + seg.length) lo = mid + 1;
      else return seg;
    }
    return undefined;
  };

  const findChange = (baseLine: number): ChangedSegment | undefined => {
    let lo = 0;
    let hi = changes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = changes[mid];
      if (baseLine < seg.baseStart) hi = mid - 1;
      else if (baseLine >= seg.baseEnd) lo = mid + 1;
      else return seg;
    }
    return undefined;
  };

  /**
   * Where content at this base line begins in the buffer. A base line you deleted has no
   * buffer position of its own, so it resolves to the start of whatever replaced it.
   */
  const toBufferStart = (baseLine: number): number => {
    if (baseLine >= baseLines.length) {
      return bufferLines.length - (baseLines.length - baseLine);
    }
    const equal = findEqual(baseLine);
    if (equal) return equal.buffer + (baseLine - equal.base);
    const change = findChange(baseLine);
    if (change) return change.bufferStart;
    return Math.min(baseLine, bufferLines.length);
  };

  /** Same, but for an exclusive end: a deleted run resolves to the end of its replacement. */
  const toBufferEnd = (baseLine: number): number => {
    if (baseLine >= baseLines.length) {
      return bufferLines.length - (baseLines.length - baseLine);
    }
    const equal = findEqual(baseLine);
    if (equal) return equal.buffer + (baseLine - equal.base);
    const change = findChange(baseLine);
    if (change) return change.bufferEnd;
    return Math.min(baseLine, bufferLines.length);
  };

  const findEqualByBuffer = (bufferLine: number): EqualSegment | undefined => {
    let lo = 0;
    let hi = equals.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = equals[mid];
      if (bufferLine < seg.buffer) hi = mid - 1;
      else if (bufferLine >= seg.buffer + seg.length) lo = mid + 1;
      else return seg;
    }
    return undefined;
  };

  const findChangeByBuffer = (bufferLine: number): ChangedSegment | undefined => {
    let lo = 0;
    let hi = changes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = changes[mid];
      if (bufferLine < seg.bufferStart) hi = mid - 1;
      else if (bufferLine >= seg.bufferEnd) lo = mid + 1;
      else return seg;
    }
    return undefined;
  };

  const toBaseStart = (bufferLine: number): number => {
    if (bufferLine >= bufferLines.length) {
      return baseLines.length - (bufferLines.length - bufferLine);
    }
    const equal = findEqualByBuffer(bufferLine);
    if (equal) return equal.base + (bufferLine - equal.buffer);
    const change = findChangeByBuffer(bufferLine);
    if (change) return change.baseStart;
    return Math.min(bufferLine, baseLines.length);
  };

  const toBaseEnd = (bufferLine: number): number => {
    if (bufferLine >= bufferLines.length) {
      return baseLines.length - (bufferLines.length - bufferLine);
    }
    const equal = findEqualByBuffer(bufferLine);
    if (equal) return equal.base + (bufferLine - equal.buffer);
    const change = findChangeByBuffer(bufferLine);
    if (change) return change.baseEnd;
    return Math.min(bufferLine, baseLines.length);
  };

  const clamp = (n: number) => Math.max(0, Math.min(n, bufferLines.length));
  const clampBase = (n: number) => Math.max(0, Math.min(n, baseLines.length));

  return {
    localEdits,
    bufferEdits: changes.map((change) => ({
      start: change.bufferStart,
      end: change.bufferEnd
    })),
    baseLineCount: baseLines.length,
    bufferLineCount: bufferLines.length,
    clean: changes.length === 0,
    toBuffer: (baseLine) => clamp(toBufferStart(baseLine)),
    toBufferRange: (range) => {
      const start = clamp(toBufferStart(range.start));
      // An insertion point must stay a point. Widening it would make a one-line addition
      // look like it replaced whatever happens to sit at that seam in your copy.
      if (range.start === range.end) {
        return { start, end: start };
      }
      const end = clamp(toBufferEnd(range.end));
      return { start, end: Math.max(start, end) };
    },
    toBaseRange: (range) => {
      const start = clampBase(toBaseStart(range.start));
      if (range.start === range.end) {
        return { start, end: start };
      }
      const end = clampBase(toBaseEnd(range.end));
      return { start, end: Math.max(start, end) };
    }
  };
}

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

export function alignLines(baseLines: string[], bufferLines: string[]): Alignment {
  const parts = diffArrays(baseLines, bufferLines);

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

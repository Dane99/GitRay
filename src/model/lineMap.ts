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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { diffArrays } from 'diff';
import type { LineRange } from '../core/types.js';
// Types only: the worker's module must never be loaded on this thread.
import type { DiffRequest, DiffResponse, DiffRun } from './alignWorker.js';

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

/**
 * Limits for `alignLinesAsync`, which can afford to be generous: it never holds the
 * thread for more than one step of the diff, so a long alignment costs wall time — the
 * indicators arrive later — but no responsiveness.
 */
export const ASYNC_ALIGNMENT_LIMITS: AlignmentLimits = { maxEditLength: 8000, timeoutMs: 3000 };

/**
 * The synchronous first attempt `alignLinesAsync` makes.
 *
 * Nearly every real alignment is a long file with a handful of edits in it, and that
 * finishes in a millisecond or two. Doing it synchronously avoids a timer per step of the
 * diff, which is what the asynchronous mode costs. The attempt is bounded so that failing
 * it is cheap too: work is about (lines × edits), so both are capped.
 */
const QUICK_EDIT_LENGTH = 128;
const QUICK_MAX_LINES = 20_000;

type Part = { count?: number; value: string[]; added?: boolean; removed?: boolean };

/** Two line arrays with what they share at either end set aside. */
interface Trimmed {
  prefix: number;
  suffix: number;
  baseMiddle: string[];
  bufferMiddle: string[];
}

/**
 * Strip the common prefix and suffix.
 *
 * Myers walks them for free in principle, but in practice a typical edit touches a few
 * lines in the middle of a long file, and trimming means the expensive part only ever sees
 * those lines.
 */
function trim(baseLines: string[], bufferLines: string[]): Trimmed {
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
  return {
    prefix,
    suffix,
    baseMiddle: baseLines.slice(prefix, baseLines.length - suffix),
    bufferMiddle: bufferLines.slice(prefix, bufferLines.length - suffix)
  };
}

/** The diff of the middle when one side of it is empty, which needs no algorithm at all. */
function trivialMiddle({ baseMiddle, bufferMiddle }: Trimmed): Part[] | undefined {
  if (baseMiddle.length === 0 && bufferMiddle.length === 0) return [];
  if (baseMiddle.length === 0) return [{ count: bufferMiddle.length, value: bufferMiddle, added: true }];
  if (bufferMiddle.length === 0) return [{ count: baseMiddle.length, value: baseMiddle, removed: true }];
  return undefined;
}

function withEnds({ prefix, suffix }: Trimmed, middle: Part[]): Part[] {
  const parts: Part[] = [];
  if (prefix > 0) parts.push({ count: prefix, value: [] });
  parts.push(...middle);
  if (suffix > 0) parts.push({ count: suffix, value: [] });
  return parts;
}

function jsdiffOptions(limits: AlignmentLimits | undefined): object | undefined {
  return limits ? { maxEditLength: limits.maxEditLength, timeout: limits.timeoutMs } : undefined;
}

/** Align without limits. Always produces an answer, however long it takes. */
export function alignLines(baseLines: string[], bufferLines: string[]): Alignment {
  return alignLinesWithin(baseLines, bufferLines, undefined) as Alignment;
}

/**
 * Align, or return undefined when the two sides are too far apart to be worth it.
 *
 * Synchronous: the whole diff runs before this returns, holding the thread for up to
 * `limits.timeoutMs`. The extension uses `alignLinesAsync`, which cannot.
 */
export function alignLinesWithin(
  baseLines: string[],
  bufferLines: string[],
  limits: AlignmentLimits | undefined = DEFAULT_ALIGNMENT_LIMITS
): Alignment | undefined {
  const trimmed = trim(baseLines, bufferLines);
  const middle =
    trivialMiddle(trimmed) ??
    (diffArrays(trimmed.baseMiddle, trimmed.bufferMiddle, jsdiffOptions(limits) as never) as
      | Part[]
      | undefined);
  return middle ? alignmentFrom(baseLines, bufferLines, withEnds(trimmed, middle)) : undefined;
}

/**
 * Align without ever holding the thread for long.
 *
 * A quick synchronous attempt first, which is enough for almost every real file; past it
 * the diff runs in jsdiff's asynchronous mode, which yields to the event loop between each
 * step. A file tens of thousands of lines long that has drifted a long way from its base
 * then takes seconds to align, but typing, hovers, and every other extension carry on
 * while it does.
 */
export async function alignLinesAsync(
  baseLines: string[],
  bufferLines: string[],
  limits: AlignmentLimits = ASYNC_ALIGNMENT_LIMITS
): Promise<Alignment | undefined> {
  const trimmed = trim(baseLines, bufferLines);
  let middle = trivialMiddle(trimmed);

  const size = trimmed.baseMiddle.length + trimmed.bufferMiddle.length;
  if (!middle && size <= QUICK_MAX_LINES) {
    middle = diffArrays(trimmed.baseMiddle, trimmed.bufferMiddle, {
      maxEditLength: Math.min(QUICK_EDIT_LENGTH, limits.maxEditLength)
    } as never) as Part[] | undefined;
  }

  middle ??= await diffOffThread(trimmed, limits);

  return middle ? alignmentFrom(baseLines, bufferLines, withEnds(trimmed, middle)) : undefined;
}

/**
 * The expensive diff, in the worker when there is one.
 *
 * The fallback is jsdiff's own asynchronous mode, which also never holds the thread for
 * long but waits on a timer between every step of the diff — and on Windows a timer is
 * never shorter than about 15 ms, so a diff of a few thousand steps takes a minute. The
 * worker runs the same diff flat out.
 */
async function diffOffThread(trimmed: Trimmed, limits: AlignmentLimits): Promise<Part[] | undefined> {
  const worker = diffWorker();
  if (worker) {
    try {
      return await worker.diff(trimmed, limits);
    } catch {
      // The worker died; the timer-driven diff still gets an answer.
    }
  }
  return new Promise<Part[] | undefined>((resolve) => {
    diffArrays(trimmed.baseMiddle, trimmed.bufferMiddle, {
      ...jsdiffOptions(limits),
      callback: (_error: unknown, value: Part[] | undefined) => resolve(value)
    } as never);
  });
}

// --- The diff worker -------------------------------------------------------------------

/** How long the worker is kept after its last diff before it is stopped. */
const WORKER_IDLE_MS = 30_000;

let sharedWorker: DiffWorker | undefined;
let workerUnavailable = false;

function diffWorker(): DiffWorker | undefined {
  if (workerUnavailable) return undefined;
  if (sharedWorker) return sharedWorker;
  // Bundled next to the extension as `alignWorker.js`; run from source it is the `.ts`
  // beside this file, and a worker inherits the loader that lets Node run it.
  const script = ['alignWorker.js', 'alignWorker.ts']
    .map((name) => join(__dirname, name))
    .find((candidate) => existsSync(candidate));
  if (!script) {
    workerUnavailable = true;
    return undefined;
  }
  sharedWorker = new DiffWorker(script, () => {
    sharedWorker = undefined;
  });
  return sharedWorker;
}

/**
 * One worker thread, started on first use and stopped when idle.
 *
 * Unreferenced whenever it has nothing to do, so an idle worker never keeps a process
 * alive — the extension host's shutdown, or a test run's.
 */
class DiffWorker {
  private readonly worker: Worker;
  private readonly waiting = new Map<number, (runs: DiffRun[] | undefined) => void>();
  private readonly failures = new Map<number, (error: Error) => void>();
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(script: string, private readonly onExit: () => void) {
    // Run from source — the tests, the performance harness — the script is TypeScript, and
    // a worker does not inherit the loader the main thread was started with, so it gets a
    // one-line bootstrap that registers it. The shipped bundle is plain JavaScript.
    this.worker = script.endsWith('.ts')
      ? new Worker(`require('tsx/cjs'); require(${JSON.stringify(script)});`, { eval: true })
      : new Worker(script);
    this.worker.unref();
    this.worker.on('message', (response: DiffResponse) => {
      this.waiting.get(response.id)?.(response.runs);
      this.settle(response.id);
    });
    const fail = (error: Error) => {
      for (const reject of this.failures.values()) reject(error);
      this.waiting.clear();
      this.failures.clear();
      this.onExit();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', (code) => fail(new Error(`diff worker exited with code ${code}`)));
  }

  diff(trimmed: Trimmed, limits: AlignmentLimits): Promise<Part[] | undefined> {
    const id = this.nextId++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.worker.ref();

    return new Promise((resolve, reject) => {
      this.waiting.set(id, (runs) =>
        resolve(runs?.map((run) => ({ count: run.count, value: [], added: run.added, removed: run.removed })))
      );
      this.failures.set(id, reject);
      const request: DiffRequest = {
        id,
        base: trimmed.baseMiddle.join('\n'),
        buffer: trimmed.bufferMiddle.join('\n'),
        maxEditLength: limits.maxEditLength,
        timeoutMs: limits.timeoutMs
      };
      this.worker.postMessage(request);
    });
  }

  private settle(id: number): void {
    this.waiting.delete(id);
    this.failures.delete(id);
    if (this.waiting.size > 0) return;
    this.worker.unref();
    this.idleTimer = setTimeout(() => void this.worker.terminate(), WORKER_IDLE_MS);
    this.idleTimer.unref();
  }
}

function alignmentFrom(baseLines: string[], bufferLines: string[], parts: Part[]): Alignment {

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

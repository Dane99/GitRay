/**
 * The line diff, run off the extension host's thread.
 *
 * Aligning a large file that has drifted a long way from its base is seconds of pure CPU.
 * On the extension host's thread that is seconds of frozen editor for everyone; in a worker
 * it is seconds of waiting for this one file's indicators, and nothing else notices. See
 * `alignLinesAsync` in lineMap.ts, which is the only thing that talks to this.
 *
 * Lines arrive joined into one string each, because a string crosses the thread boundary
 * as a single copy while an array of a hundred thousand strings is a hundred thousand
 * objects to clone — on the sending thread, which is the one this exists to spare. What
 * goes back is just the shape of the diff: runs of equal, added, and removed lines.
 */

import { parentPort } from 'node:worker_threads';
import { diffArrays } from 'diff';

export interface DiffRequest {
  id: number;
  base: string;
  buffer: string;
  maxEditLength: number;
  timeoutMs: number;
}

export interface DiffRun {
  count: number;
  added: boolean;
  removed: boolean;
}

export interface DiffResponse {
  id: number;
  /** Undefined when the diff gave up at its limits. */
  runs: DiffRun[] | undefined;
}

parentPort?.on('message', (request: DiffRequest) => {
  const parts = diffArrays(request.base.split('\n'), request.buffer.split('\n'), {
    maxEditLength: request.maxEditLength,
    timeout: request.timeoutMs
  } as never) as { count?: number; value: string[]; added?: boolean; removed?: boolean }[] | undefined;

  const response: DiffResponse = {
    id: request.id,
    runs: parts?.map((part) => ({
      count: part.count ?? part.value.length,
      added: part.added === true,
      removed: part.removed === true
    }))
  };
  parentPort?.postMessage(response);
});

/**
 * Bounded concurrency for work that mostly waits on git.
 */

import { log } from './log.js';

/**
 * Run `work` over `items`, at most `limit` at a time.
 *
 * Enough to keep git busy without starting a process per item at once, which on Windows
 * would cost as much in process creation — synchronous, on the extension host's thread —
 * as it saved in waiting. A failing item is logged and skipped rather than failing the rest.
 */
export async function inParallel<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await work(item);
      } catch (error) {
        log.debug(`parallel work failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

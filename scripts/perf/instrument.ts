/**
 * Measurement for the performance harness.
 *
 * Everything here observes from the outside. The extension's own code is not modified to be
 * measurable: git processes are counted by wrapping `child_process`, work is timed by
 * wrapping a few prototype methods, and blocking is measured by watching how late a timer
 * fires. The one thing a user actually feels — the editor not responding — is the last of
 * these, so it is the number every budget is built around.
 */

import childProcess from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { writeFileSync } from 'node:fs';

// --- Git processes ----------------------------------------------------------------------

export interface SpawnRecord {
  /** The git subcommand, e.g. `diff` or `rev-parse`. */
  command: string;
  startedAt: number;
  durationMs: number;
}

interface SpawnState {
  inFlight: number;
  records: SpawnRecord[];
  /** Long-lived processes started with `spawn`, such as `cat-file --batch`. */
  longLived: number;
}

const spawns: SpawnState = { inFlight: 0, records: [], longLived: 0 };
let lastActivity = performance.now();

export function touch(): void {
  lastActivity = performance.now();
}

/** The git subcommand among an argument list, skipping `-c key=value` and global flags. */
function subcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c' || arg === '-C') {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return '?';
}

/**
 * Count every git process the extension starts.
 *
 * Installed before the extension is loaded. The extension's modules read `execFile` off
 * the module object at call time, so replacing the property is enough to see every call.
 */
export function installSpawnProbe(): void {
  const cp = childProcess as unknown as Record<string, unknown>;
  const originalExecFile = childProcess.execFile;
  const originalSpawn = childProcess.spawn;

  cp.execFile = function (file: string, args: readonly string[], options: unknown, callback: unknown) {
    const started = performance.now();
    const command = file === 'git' ? subcommand(args ?? []) : file;
    spawns.inFlight++;
    touch();
    const done = (...results: unknown[]) => {
      spawns.inFlight--;
      spawns.records.push({ command, startedAt: started, durationMs: performance.now() - started });
      touch();
      if (typeof callback === 'function') (callback as (...a: unknown[]) => void)(...results);
    };
    return (originalExecFile as unknown as (...a: unknown[]) => unknown)(file, args, options, done);
  };

  cp.spawn = function (...spawnArgs: unknown[]) {
    const [file, args] = spawnArgs as [string, readonly string[]];
    if (file === 'git') {
      spawns.longLived++;
      spawns.records.push({ command: subcommand(args ?? []), startedAt: performance.now(), durationMs: 0 });
    }
    touch();
    return (originalSpawn as unknown as (...a: unknown[]) => unknown)(...spawnArgs);
  };
}

export function spawnsInFlight(): number {
  return spawns.inFlight;
}

export function spawnRecords(): readonly SpawnRecord[] {
  return spawns.records;
}

// --- Work in progress ------------------------------------------------------------------

/** Named counters for wrapped methods: how many calls, how long in total, how many running. */
export interface WorkCounter {
  calls: number;
  totalMs: number;
  running: number;
}

const counters = new Map<string, WorkCounter>();

export function counter(name: string): WorkCounter {
  let found = counters.get(name);
  if (!found) {
    found = { calls: 0, totalMs: 0, running: 0 };
    counters.set(name, found);
  }
  return found;
}

export function snapshotCounters(): Record<string, WorkCounter> {
  return Object.fromEntries([...counters].map(([name, value]) => [name, { ...value }]));
}

/**
 * Time an async method on a prototype, and count it as activity.
 *
 * Silently does nothing when the method does not exist, so the harness can measure older
 * builds of the extension that predate some of what it looks for.
 */
export function wrapAsync(prototype: object, method: string, name: string): void {
  const target = prototype as Record<string, unknown>;
  const original = target[method];
  if (typeof original !== 'function') return;

  target[method] = async function (this: unknown, ...args: unknown[]) {
    const work = counter(name);
    work.calls++;
    work.running++;
    touch();
    const started = performance.now();
    try {
      return await (original as (...a: unknown[]) => Promise<unknown>).apply(this, args);
    } finally {
      work.running--;
      work.totalMs += performance.now() - started;
      touch();
    }
  };
}

function anythingRunning(): boolean {
  if (spawns.inFlight > 0) return true;
  for (const work of counters.values()) if (work.running > 0) return true;
  return false;
}

// --- Blocking -------------------------------------------------------------------------

export interface Block {
  /** When the block ended, relative to the phase start. */
  atMs: number;
  durationMs: number;
}

/**
 * Watches for the event loop being held.
 *
 * A timer asks to run every `TICK_MS`; however late it actually runs is how long something
 * else held the thread. In the extension host that thread is shared with every other
 * extension and with the editor's own requests for hovers, completions, and decorations,
 * so a long block here is a freeze the user sees.
 */
const TICK_MS = 5;
/** Delays at or above this count as a block worth reporting. */
export const BLOCK_THRESHOLD_MS = 25;

export class LoopMonitor {
  private timer: NodeJS.Timeout | undefined;
  private expected = 0;
  private startedAt = 0;
  private readonly histogram = monitorEventLoopDelay({ resolution: 10 });
  readonly blocks: Block[] = [];
  maxMs = 0;

  start(): void {
    this.startedAt = performance.now();
    this.expected = this.startedAt + TICK_MS;
    this.histogram.reset();
    this.histogram.enable();
    this.timer = setInterval(() => {
      const now = performance.now();
      const late = now - this.expected;
      if (late > this.maxMs) this.maxMs = late;
      if (late >= BLOCK_THRESHOLD_MS) {
        this.blocks.push({ atMs: now - this.startedAt, durationMs: late });
      }
      this.expected = now + TICK_MS;
    }, TICK_MS);
  }

  stop(): { maxMs: number; blockedMs: number; blocks: number; p99Ms: number } {
    if (this.timer) clearInterval(this.timer);
    this.histogram.disable();
    return {
      maxMs: round(this.maxMs),
      blockedMs: round(this.blocks.reduce((total, block) => total + block.durationMs, 0)),
      blocks: this.blocks.length,
      p99Ms: round(this.histogram.percentile(99) / 1e6)
    };
  }
}

// --- Quiescence ------------------------------------------------------------------------

/**
 * Wait until the extension has finished reacting.
 *
 * A trigger — a sync, a keystroke, a save — sets off a chain: debounced announcements,
 * debounced scans, analyses, repaints. "Done" is when nothing has been running for
 * `idleMs`, which has to be longer than the longest debounce in the chain. Returns when the
 * last piece of work finished, which is the wall time a user would perceive.
 */
export async function quiescence(options: { idleMs?: number; timeoutMs?: number } = {}): Promise<number> {
  const idleMs = options.idleMs ?? 700;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const started = performance.now();

  for (;;) {
    await sleep(25);
    const now = performance.now();
    if (!anythingRunning() && now - lastActivity >= idleMs) return lastActivity;
    if (now - started > timeoutMs) {
      throw new Error(`the extension was still busy after ${Math.round(timeoutMs / 1000)}s`);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- CPU profiles ---------------------------------------------------------------------

/**
 * A CPU profile of the harness process, which is where the extension runs.
 *
 * Written in the `.cpuprofile` format, which VS Code and Chrome's DevTools both open. This
 * is the answer to "it is slow, but where": the flame chart names the function.
 */
export class Profiler {
  private readonly session = new Session();
  private running = false;

  async start(): Promise<void> {
    this.session.connect();
    await this.post('Profiler.enable');
    await this.post('Profiler.setSamplingInterval', { interval: 200 });
    await this.post('Profiler.start');
    this.running = true;
  }

  async stop(path: string): Promise<void> {
    if (!this.running) return;
    const result = (await this.post('Profiler.stop')) as { profile: unknown };
    writeFileSync(path, JSON.stringify(result.profile));
    this.session.disconnect();
    this.running = false;
  }

  private post(method: string, params?: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result)));
    });
  }
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return round(sorted[Math.max(0, index)]);
}

/**
 * One testbed, one build, one run: the real extension through a developer's day.
 *
 * Run by `run.ts` in a process of its own per testbed, so nothing one repository leaves
 * behind — module state, caches, heap — reaches the next. Writes its results as JSON to
 * the path given by `--out`.
 *
 * The phases follow what a developer actually does, in order: the window opens, the poll
 * finds nothing new, they refresh, open a file someone else is working on, type in it,
 * move around it, save, and commit. Each phase is measured from its trigger until the
 * extension has stopped reacting to it.
 */

/* eslint-disable no-console */

import Module from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  installSpawnProbe,
  LoopMonitor,
  percentile,
  Profiler,
  quiescence,
  round,
  sleep,
  snapshotCounters,
  spawnRecords,
  touch,
  wrapAsync,
  type WorkCounter
} from './instrument.js';
import { createHost, type FakeEditor, type Host } from './host.js';
import {
  cacheDir,
  ensureClone,
  loadRecording,
  PROJECT_ROOT,
  record,
  resetScenario,
  sourceRoot,
  type Recording,
  type Scenario
} from './prepare.js';
import { budgetFor, TESTBEDS, type Budget, type PhaseName, type Testbed } from './testbeds.js';

// --- Results --------------------------------------------------------------------------

export interface PhaseResult {
  name: PhaseName;
  wallMs: number;
  maxBlockMs: number;
  /** Total time spent in blocks of 25 ms or more. */
  blockedMs: number;
  blocks: number;
  p99LagMs: number;
  gitSpawns: number;
  /** Git processes by subcommand, most frequent first. */
  spawnsByCommand: Record<string, number>;
  /** Wall time git processes were running, summed; overlapping ones count twice. */
  gitMs: number;
  analyses: number;
  analyzeMs: number;
  scans: number;
  syncs: number;
  blobReads: number;
  treeWalks: number;
  treeMs: number;
  badgeQueries: number;
  badgeMs: number;
  decorationCalls: number;
  heapMb: number;
  /** For input phases: how long each event handler held the thread. */
  handler?: { count: number; p50Ms: number; p95Ms: number; maxMs: number };
  /** For typing: last keystroke to the last repaint it caused. */
  settleMs?: number;
  violations: string[];
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface BenchResult {
  testbed: string;
  repo: string;
  /** The extension build measured: a ref, or `working tree`. */
  build: string;
  buildCommit: string;
  mode: 'replay' | 'live';
  recordedAt: string;
  startedAt: string;
  environment: { node: string; git: string; platform: string; cpus: number; timerFloorMs: number };
  scenario: { pullRequests: number; editedFiles: number; behind: number };
  phases: PhaseResult[];
  checks: Check[];
  logPath: string;
}

// --- Arguments ----------------------------------------------------------------------

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const say = (line: string) => console.log(`  ${line}`);

// --- Setup --------------------------------------------------------------------------

function githubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('recording needs a GitHub token: set GITHUB_TOKEN or sign in with `gh auth login`');
  }
}

async function ensureRecording(testbed: Testbed, dir: string, refresh: boolean): Promise<Recording> {
  const existing = loadRecording(testbed);
  if (existing && !refresh) return existing;

  const token = githubToken();
  // Always the current project's client, so recordings do not depend on the build under test.
  const { GitHubApi } = require(join(PROJECT_ROOT, 'src/providers/githubApi.ts'));
  const [owner, name] = testbed.repo.split('/');
  const remote = { host: 'github.com', owner, name, nameWithOwner: testbed.repo };
  return record(
    testbed,
    dir,
    (fetchImpl) =>
      new GitHubApi(remote, { supports: () => true, getToken: async () => token }, fetchImpl).listPullRequests(
        100,
        true
      ),
    say
  );
}

/**
 * Stand in for GitHub, answering GitRay's two queries from the recording.
 *
 * The probe is answered for any repository; the list is the recorded response, verbatim.
 * Anything else is a request the harness does not know about, and fails loudly.
 */
function replayGitHub(recording: Recording): void {
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
    const query = body.query ?? '';
    if (query.includes('GitRayProbe')) {
      return Response.json({
        data: { viewer: { login: 'gitray-perf' }, repository: { nameWithOwner: recording.repo } }
      });
    }
    if (query.includes('GitRayPullRequests')) return Response.json(recording.payload);
    throw new Error(`the harness has no recording for this request: ${query.slice(0, 80)}`);
  };
}

// --- Main -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const testbed = TESTBEDS.find((candidate) => candidate.id === option('testbed'));
  if (!testbed) throw new Error(`unknown testbed ${option('testbed')}`);
  const out = option('out');
  if (!out) throw new Error('--out is required');
  const ref = option('src');
  const live = flag('live');
  const profile = flag('profile');

  const srcRoot = sourceRoot(ref, say);
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: srcRoot, encoding: 'utf8' }).trim();
  // Uncommitted changes to the extension are what is usually being measured, and a result
  // labelled with the commit alone would claim to be that commit.
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: srcRoot, encoding: 'utf8' }).trim() !== '';
  const buildCommit = dirty ? `${commit}+changes` : commit;

  const dir = ensureClone(testbed, say);
  const recording = await ensureRecording(testbed, dir, flag('refresh'));

  // The manifest's defaults, so the planted edits avoid exactly the files GitRay ignores.
  const manifest = require(join(PROJECT_ROOT, 'package.json'));
  const ignoreGlobs: string[] = manifest.contributes.configuration.properties['gitray.ignoreGlobs'].default;
  const { matchesAny } = require(join(PROJECT_ROOT, 'src/core/glob.ts'));
  const scenario = resetScenario(testbed, dir, recording, (path) => matchesAny(path, ignoreGlobs));
  say(`scenario: ${scenario.edited.length} files edited, ${testbed.behind} commits behind ${testbed.branch}`);

  const host = createHost(dir);
  const settings = host.stub.settings;
  settings['gitray.refreshInterval'] = 0; // the harness triggers every sync itself
  settings['gitray.maxPullRequests'] = testbed.maxPullRequests;
  settings['gitray.mainline.branch'] = testbed.branch;
  settings['gitray.remote'] = live ? 'source' : 'origin';
  host.stub.githubSession = { accessToken: live ? githubToken() : 'replay', account: { label: 'gitray-perf' } };

  const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = loader._load;
  loader._load = function (request, parent, isMain) {
    if (request === 'vscode') return host.api;
    return original.call(this, request, parent, isMain);
  };
  installSpawnProbe();

  const load = (path: string) => require(join(srcRoot, 'src', path));
  const extension = load('extension.ts');
  const { Workspace } = load('workspace.ts');
  const { Analyzer } = load('model/analyzer.ts');
  const { CollisionScanner } = load('sync/scanner.ts');
  const { SyncEngine } = load('sync/engine.ts');
  const { Git } = load('providers/git.ts');

  let lastSyncEnd = 0;
  const sync = SyncEngine.prototype.sync;
  SyncEngine.prototype.sync = async function (this: unknown, ...args: unknown[]) {
    try {
      return await sync.apply(this, args);
    } finally {
      lastSyncEnd = performance.now();
    }
  };
  wrapAsync(SyncEngine.prototype, 'sync', 'sync');
  wrapAsync(Analyzer.prototype, 'analyze', 'analyze');
  wrapAsync(CollisionScanner.prototype, 'scan', 'scan');
  wrapAsync(Git.prototype, 'readFile', 'blobRead');

  let workspace: any;
  const refresh = Workspace.prototype.refresh;
  Workspace.prototype.refresh = function (this: unknown, ...args: unknown[]) {
    workspace = this;
    return refresh.apply(this, args);
  };

  if (!live) {
    replayGitHub(recording);
    // `origin` is the clone itself, so its heads are served locally; this is what makes
    // GitRay believe it points at the GitHub repository the recording came from.
    const remoteUrl = Git.prototype.remoteUrl;
    Git.prototype.remoteUrl = async function (this: unknown, name: string) {
      return name === 'origin' ? `https://github.com/${recording.repo}.git` : remoteUrl.call(this, name);
    };
  }

  const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);
  // Roughly a screenful of explorer, plus the files you are working on.
  host.setExplorerRows([...tracked.slice(0, 250), ...scenario.edited.map((file) => file.path)]);

  const result: BenchResult = {
    testbed: testbed.id,
    repo: testbed.repo,
    build: ref ?? 'working tree',
    buildCommit,
    mode: live ? 'live' : 'replay',
    recordedAt: recording.recordedAt,
    startedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
      platform: `${process.platform} ${process.arch}`,
      cpus: require('node:os').cpus().length,
      timerFloorMs: await timerFloor()
    },
    scenario: { pullRequests: 0, editedFiles: scenario.edited.length, behind: testbed.behind },
    phases: [],
    checks: [],
    logPath: ''
  };
  const check = (name: string, ok: boolean, detail: string) => result.checks.push({ name, ok, detail });

  const measure = measurer(testbed, host, profile);
  /** Wait out the scheduler's five-second minimum gap, so the next sync is not deferred. */
  const clearOfLastSync = async () => {
    const wait = lastSyncEnd + 5_200 - performance.now();
    if (wait > 0) await sleep(wait);
  };

  // --- Startup: the window opens.
  result.phases.push(await measure('startup', async () => extension.activate(host.stub.context)));
  const session = workspace?.all()[0];
  if (!session) throw new Error('GitRay did not attach to the testbed repository');

  const status = session.store.currentStatus();
  result.scenario.pullRequests = session.store.allPullRequests().length;
  check('pull requests loaded', result.scenario.pullRequests > 0, `${result.scenario.pullRequests} open`);
  check('line-level indicators available', status.state === 'ready', `${status.state}${status.message ? `: ${status.message}` : ''}`);
  const collisionsAtStart = session.scanner.collisionCount();
  const hotAtStart = session.scanner.hotFiles().map((file: { path: string }) => file.path);
  check('collisions found', collisionsAtStart > 0, `${collisionsAtStart} in ${hotAtStart.length} files`);
  check('mainline drift found', session.store.hasMainlineDrift(), session.store.mainline()?.branch ?? 'no mainline');

  // --- Idle poll: a minute passes and nothing has changed.
  await clearOfLastSync();
  const idle = await measure('idle-poll', async () => session.scheduler.request('interval'));
  result.phases.push(idle);
  check('an idle poll does not rescan', idle.scans === 0, `${idle.scans} scans`);

  // --- Refresh: the user asks for it.
  await clearOfLastSync();
  result.phases.push(await measure('refresh', async () => host.stub.registeredCommands.get('gitray.refresh')?.()));
  const hotAfterRefresh = session.scanner.hotFiles().map((file: { path: string }) => file.path);
  check(
    'a refresh over unchanged state finds the same collisions',
    session.scanner.collisionCount() === collisionsAtStart && hotAfterRefresh.join('\n') === hotAtStart.join('\n'),
    `${session.scanner.collisionCount()} (was ${collisionsAtStart})`
  );

  // --- Open a file somebody else is working on, at the line where you collide.
  const target = pickTarget(session, scenario);
  let editor: FakeEditor | undefined;
  result.phases.push(
    await measure('open-file', async () => {
      editor = host.openEditor(target.path, target.line);
    })
  );
  if (!editor) throw new Error('the editor did not open');
  const opened = session.controller.analysisFor(editor.document.uri);
  check('the open file is analyzed', (opened?.regions.length ?? 0) > 0, `${opened?.regions.length ?? 0} regions in ${target.path}`);
  const active = editor;

  // --- Type: a steady typist, about twelve characters a second.
  const keystrokes: number[] = [];
  let lastKey = 0;
  const typing = await measure('typing', async () => {
    for (let i = 0; i < 60; i++) {
      active.type(i % 8 === 7 ? ' ' : 'x');
      keystrokes.push(host.fire.textChange(active) + host.fire.selection(active));
      lastKey = performance.now();
      await sleep(80);
    }
  });
  typing.handler = handlerStats(keystrokes);
  typing.settleMs = round(Math.max(0, (typing as PhaseResult & { endedAt?: number }).endedAt! - lastKey));
  result.phases.push(typing);
  const afterTyping = session.controller.analysisFor(active.document.uri);
  check('indicators survive typing', (afterTyping?.regions.length ?? 0) > 0, `${afterTyping?.regions.length ?? 0} regions`);

  // --- Move around: arrow down through the file and back.
  const moves: number[] = [];
  const cursor = await measure('cursor', async () => {
    const start = active.selection.active.line;
    for (let i = 0; i < 100; i++) {
      active.moveTo(i < 50 ? start + i : start + 100 - i);
      moves.push(host.fire.selection(active));
      await sleep(25);
    }
  });
  cursor.handler = handlerStats(moves);
  result.phases.push(cursor);

  // --- Save.
  await clearOfLastSync();
  result.phases.push(
    await measure('save', async () => {
      writeFileSync(active.document.fileName, active.document.getText(), 'utf8');
      host.fire.save(active);
    })
  );

  // --- Commit: HEAD moves, and every merge base with it.
  await clearOfLastSync();
  execFileSync('git', ['commit', '-q', '-am', 'perf: commit your work'], { cwd: dir });
  result.phases.push(await measure('commit', async () => session.scheduler.request('HEAD changed')));
  check('collisions survive a commit', session.scanner.collisionCount() > 0, `${session.scanner.collisionCount()} collisions`);

  // --- Wind down.
  let disposed = true;
  try {
    extension.deactivate();
  } catch (error) {
    disposed = false;
    host.stub.errors.push(`deactivate threw: ${String(error)}`);
  }
  check('deactivates cleanly', disposed, disposed ? 'ok' : 'threw');
  check('no errors logged', host.stub.errors.length === 0, host.stub.errors.slice(0, 3).join(' | ') || 'none');

  for (const phase of result.phases) delete (phase as { endedAt?: number }).endedAt;
  applyBudgets(testbed, result.phases);

  const logPath = out.replace(/\.json$/, '.log');
  writeFileSync(logPath, host.log.join('\n'));
  result.logPath = logPath;
  writeFileSync(out, JSON.stringify(result, null, 2));
}

// --- Measuring a phase ---------------------------------------------------------------

function measurer(testbed: Testbed, host: Host, profile: boolean) {
  return async (name: PhaseName, trigger: () => Promise<unknown>): Promise<PhaseResult & { endedAt?: number }> => {
    const spawnsBefore = spawnRecords().length;
    const countersBefore = snapshotCounters();
    const surfacesBefore = { ...host.surfaces };
    const profiler = profile ? new Profiler() : undefined;
    await profiler?.start();

    const monitor = new LoopMonitor();
    monitor.start();
    const started = performance.now();
    touch();
    await trigger();
    const endedAt = await quiescence();
    const loop = monitor.stop();

    if (profiler) {
      const dir = join(cacheDir(), 'profiles');
      mkdirSync(dir, { recursive: true });
      await profiler.stop(join(dir, `${testbed.id}-${name}.cpuprofile`));
    }

    const spawned = spawnRecords().slice(spawnsBefore);
    const byCommand: Record<string, number> = {};
    for (const record of spawned) byCommand[record.command] = (byCommand[record.command] ?? 0) + 1;
    const counters = snapshotCounters();
    const delta = (key: string, field: keyof WorkCounter) =>
      (counters[key]?.[field] ?? 0) - (countersBefore[key]?.[field] ?? 0);

    const phase: PhaseResult & { endedAt?: number } = {
      name,
      wallMs: round(Math.max(0, endedAt - started)),
      maxBlockMs: loop.maxMs,
      blockedMs: loop.blockedMs,
      blocks: loop.blocks,
      p99LagMs: loop.p99Ms,
      gitSpawns: spawned.length,
      spawnsByCommand: Object.fromEntries(Object.entries(byCommand).sort((a, b) => b[1] - a[1])),
      gitMs: round(spawned.reduce((total, record) => total + record.durationMs, 0)),
      analyses: delta('analyze', 'calls'),
      analyzeMs: round(delta('analyze', 'totalMs')),
      scans: delta('scan', 'calls'),
      syncs: delta('sync', 'calls'),
      blobReads: delta('blobRead', 'calls'),
      treeWalks: host.surfaces.treeWalks - surfacesBefore.treeWalks,
      treeMs: round(host.surfaces.treeMs - surfacesBefore.treeMs),
      badgeQueries: host.surfaces.badgeQueries - surfacesBefore.badgeQueries,
      badgeMs: round(host.surfaces.badgeMs - surfacesBefore.badgeMs),
      decorationCalls: host.surfaces.decorationCalls - surfacesBefore.decorationCalls,
      heapMb: round(process.memoryUsage().heapUsed / 1024 / 1024),
      violations: [],
      endedAt
    };
    say(
      `${name.padEnd(10)} ${String(phase.wallMs).padStart(8)} ms   block ${String(phase.maxBlockMs).padStart(6)} ms   ` +
        `${String(phase.gitSpawns).padStart(4)} git   ${String(phase.analyses).padStart(4)} analyses`
    );
    return phase;
  };
}

/**
 * How late the block monitor's timer runs when nothing at all is happening.
 *
 * Any max block at or below this is the platform's timer granularity, not the extension:
 * on Windows timers fire in steps of about 15.6 ms however short the interval asked for.
 */
async function timerFloor(): Promise<number> {
  const monitor = new LoopMonitor();
  monitor.start();
  await sleep(1000);
  return monitor.stop().maxMs;
}

function handlerStats(samples: readonly number[]) {
  return {
    count: samples.length,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    maxMs: round(Math.max(0, ...samples))
  };
}

/** The file to open: the most colliding one, at its first collision. */
function pickTarget(session: any, scenario: Scenario): { path: string; line: number } {
  for (const analysis of session.scanner.hotFiles()) {
    const collision = analysis.regions.find((region: { severity: string }) => region.severity === 'collision');
    if (collision) return { path: analysis.path, line: collision.range.start };
  }
  const first = scenario.edited[0];
  if (!first) throw new Error('the scenario planted no edits');
  return { path: first.path, line: first.line };
}

/** Held to the testbed's budgets; each phase records what it went over. */
export function applyBudgets(testbed: Testbed, phases: PhaseResult[]): void {
  for (const phase of phases) {
    const budget: Partial<Budget> = budgetFor(testbed, phase.name);
    const over = (label: string, actual: number | undefined, limit: number | undefined) => {
      if (limit !== undefined && actual !== undefined && actual > limit) {
        phase.violations.push(`${label} ${actual} > ${limit}`);
      }
    };
    over('max block ms', phase.maxBlockMs, budget.maxBlockMs);
    over('wall ms', phase.wallMs, budget.wallMs);
    over('git spawns', phase.gitSpawns, budget.gitSpawns);
    over('handler p95 ms', phase.handler?.p95Ms, budget.handlerP95Ms);
    over('settle ms', phase.settleMs, budget.settleMs);
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    }
  );
}

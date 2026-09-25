/**
 * Getting a testbed repository into a known state.
 *
 * Three things have to hold for two runs to be comparable:
 *
 *  - **The same pull requests.** The open list changes by the hour, so it is recorded once
 *    from GitHub and replayed. Each recorded head is fetched into the clone at the same
 *    time, and the recording is rewritten to the commit that actually arrived.
 *  - **The same mainline.** The clone's own default branch is pinned to where it was when
 *    the recording was made.
 *  - **The same "you".** Your branch is re-created from scratch before every run, a fixed
 *    number of commits behind the mainline, with the same edits planted in the same files.
 *
 * GitRay itself is then pointed at a remote that is the clone itself, so its fetches are
 * real `git fetch` processes that find everything already local. Nothing touches the
 * network after recording, unless `--live` asks for it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Testbed } from './testbeds.js';

export const PROJECT_ROOT = resolve(__dirname, '..', '..');

/** Where clones, recordings, results, and profiles live. Far outside the project. */
export function cacheDir(): string {
  const base =
    process.env.GITRAY_PERF_DIR ??
    join(process.env.LOCALAPPDATA ?? join(homedir(), '.cache'), 'gitray-perf');
  mkdirSync(base, { recursive: true });
  return base;
}

export function repoDir(testbed: Testbed): string {
  return join(cacheDir(), 'repos', testbed.repo.replace('/', '__'));
}

/** The remote holding the real GitHub URL. Deliberately not a name GitRay would pick. */
const SOURCE_REMOTE = 'source';
/** The branch "you" are on. */
export const WORK_BRANCH = 'gitray-perf';
/** Appended to every line the harness edits, so the edits are easy to spot. */
const MARKER = ' /* gitray-perf */';

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

// --- Clone ---------------------------------------------------------------------------

/**
 * Clone the testbed if it is not already here, and wire up its remotes.
 *
 * Full history and every blob, deliberately: GitRay needs real merge bases, and a partial
 * clone would fetch file contents from the network in the middle of a measurement.
 */
export function ensureClone(testbed: Testbed, log: (line: string) => void): string {
  const dir = repoDir(testbed);
  const url = `https://github.com/${testbed.repo}.git`;

  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(join(dir, '..'), { recursive: true });
    log(`cloning ${testbed.repo} (full history, this takes a few minutes)`);
    execFileSync(
      'git',
      ['clone', '--no-tags', '--single-branch', '--branch', testbed.branch, '--origin', SOURCE_REMOTE, url, dir],
      { stdio: 'inherit' }
    );
  }

  const remotes = git(dir, ['remote']).split('\n').map((line) => line.trim()).filter(Boolean);
  // A clone made by hand has the real URL on `origin`; move it aside.
  if (!remotes.includes(SOURCE_REMOTE)) {
    git(dir, ['remote', 'rename', 'origin', SOURCE_REMOTE]);
  }
  if (!git(dir, ['remote']).split('\n').map((line) => line.trim()).includes('origin')) {
    git(dir, ['remote', 'add', 'origin', dir]);
  }

  // Owned by the harness, so it can be configured freely. Automatic gc would otherwise
  // repack in the background at an unpredictable moment and land in someone's numbers.
  for (const [key, value] of [
    ['user.email', 'perf@gitray.invalid'],
    ['user.name', 'GitRay Perf'],
    ['commit.gpgsign', 'false'],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false']
  ]) {
    git(dir, ['config', key, value]);
  }
  return dir;
}

// --- Recording -------------------------------------------------------------------------

export interface Recording {
  repo: string;
  recordedAt: string;
  /** The mainline tip at recording time; the clone's default branch is pinned here. */
  tip: string;
  /** GitHub's GraphQL answer to GitRay's own pull request query, heads rewritten. */
  payload: unknown;
}

export function recordingPath(testbed: Testbed): string {
  return join(cacheDir(), 'recordings', `${testbed.id}.json`);
}

export function loadRecording(testbed: Testbed): Recording | undefined {
  const path = recordingPath(testbed);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Recording) : undefined;
}

interface PayloadNode {
  number: number;
  headRefOid: string;
  files?: { nodes?: ({ path: string } | null)[] | null } | null;
}

export function payloadNodes(payload: unknown): PayloadNode[] {
  const nodes = (payload as { data?: { repository?: { pullRequests?: { nodes?: unknown[] } } } })
    ?.data?.repository?.pullRequests?.nodes;
  return (nodes ?? []).filter((node): node is PayloadNode => node !== null && typeof node === 'object');
}

/**
 * Record the open pull requests and bring every head into the clone.
 *
 * `listPullRequests` is the extension's own client, handed a `fetch` that keeps a copy of
 * the response — so what is replayed later is byte for byte what GitRay asked for.
 */
export async function record(
  testbed: Testbed,
  dir: string,
  listPullRequests: (fetchImpl: typeof fetch) => Promise<unknown>,
  log: (line: string) => void
): Promise<Recording> {
  log(`recording ${testbed.repo}: fetching the mainline`);
  // Detach first, so the default branch is free to be moved by the fetch below.
  git(dir, ['checkout', '-q', '--detach']);
  git(dir, ['fetch', '-q', '--no-tags', SOURCE_REMOTE, `+refs/heads/${testbed.branch}:refs/heads/${testbed.branch}`]);
  const tip = git(dir, ['rev-parse', `refs/heads/${testbed.branch}`]).trim();

  log('recording the open pull requests from GitHub');
  let body = '';
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    body = await response.text();
    return new Response(body, { status: response.status, headers: response.headers });
  };
  await listPullRequests(recordingFetch);
  const payload = JSON.parse(body) as unknown;
  const nodes = payloadNodes(payload);
  if (nodes.length === 0) throw new Error(`GitHub returned no open pull requests for ${testbed.repo}`);

  log(`fetching ${nodes.length} pull request heads`);
  const refspecs = nodes.map((node) => `+refs/pull/${node.number}/head:refs/pull/${node.number}/head`);
  if (tryGit(dir, ['fetch', '-q', '--no-tags', SOURCE_REMOTE, ...refspecs]) === undefined) {
    // One vanished head fails the whole batch; fall back to one at a time.
    for (const refspec of refspecs) tryGit(dir, ['fetch', '-q', '--no-tags', SOURCE_REMOTE, refspec]);
  }

  // Pin each pull request to the head that actually arrived. A push between the list and
  // the fetch would otherwise leave GitRay believing every head is stale, forever.
  const kept: PayloadNode[] = [];
  for (const node of nodes) {
    const oid = tryGit(dir, ['rev-parse', '--verify', '--quiet', `refs/pull/${node.number}/head`])?.trim();
    if (!oid) continue;
    node.headRefOid = oid;
    kept.push(node);
  }
  const repository = (payload as { data: { repository: { pullRequests: { nodes: unknown[] } } } }).data.repository;
  repository.pullRequests.nodes = kept;

  const recording: Recording = { repo: testbed.repo, recordedAt: new Date().toISOString(), tip, payload };
  mkdirSync(join(cacheDir(), 'recordings'), { recursive: true });
  writeFileSync(recordingPath(testbed), JSON.stringify(recording));
  log(`recorded ${kept.length} pull requests against ${tip.slice(0, 10)}`);
  return recording;
}

// --- The scenario ----------------------------------------------------------------------

export interface Scenario {
  root: string;
  head: string;
  /** Files with planted edits, most contested first, with the line each edit targets. */
  edited: { path: string; line: number; committed: boolean }[];
}

/**
 * Put "you" back where every run starts.
 *
 * A fresh branch `behind` commits back from the pinned tip, GitRay's refs removed so the
 * first sync is genuinely cold, and edits planted in the files other people are working
 * on — half committed on the branch, half left in the working tree, because GitRay treats
 * both as yours and reads them differently.
 */
export function resetScenario(
  testbed: Testbed,
  dir: string,
  recording: Recording,
  ignoreGlobs: (path: string) => boolean
): Scenario {
  git(dir, ['checkout', '-q', '-f', '-B', WORK_BRANCH, `${recording.tip}~${testbed.behind}`]);
  git(dir, ['clean', '-fdq']);
  git(dir, ['update-ref', `refs/heads/${testbed.branch}`, recording.tip]);

  const gitrayRefs = git(dir, ['for-each-ref', '--format=%(refname)', 'refs/gitray'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (gitrayRefs.length > 0) {
    git(dir, ['update-ref', '--stdin'], gitrayRefs.map((ref) => `delete ${ref}\n`).join(''));
  }

  const head = git(dir, ['rev-parse', 'HEAD']).trim();
  const tracked = new Set(git(dir, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n'));

  // Most contested first: the files the most pull requests touch are where collisions
  // live, and where a busy repository's cost concentrates.
  const touchedBy = new Map<string, number[]>();
  for (const node of payloadNodes(recording.payload)) {
    for (const file of node.files?.nodes ?? []) {
      if (!file) continue;
      const list = touchedBy.get(file.path) ?? [];
      list.push(node.number);
      touchedBy.set(file.path, list);
    }
  }
  const candidates = [...touchedBy.entries()]
    .filter(([path]) => tracked.has(path) && !ignoreGlobs(path) && isText(path))
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, testbed.editedFiles);

  const edited: Scenario['edited'] = [];
  candidates.forEach(([path, prNumbers], index) => {
    const full = join(dir, ...path.split('/'));
    const text = readFileSync(full, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    if (lines.length < 3) return;

    const target = Math.min(hunkLine(dir, head, prNumbers[0], path) ?? 0, lines.length - 2);
    // Their line, so there is a collision; and spread through the file, so the alignment
    // has more than one edit to line up.
    for (const at of new Set([target, ...[0.2, 0.5, 0.8].map((f) => Math.floor(lines.length * f))])) {
      if (at < lines.length - 1) lines[at] += MARKER;
    }
    lines.splice(Math.floor(lines.length * 0.6), 0, `${MARKER.trim()} inserted`, `${MARKER.trim()} inserted`);

    writeFileSync(full, lines.join(eol), 'utf8');
    edited.push({ path, line: target, committed: index % 2 === 0 });
  });

  const committed = edited.filter((file) => file.committed).map((file) => file.path);
  if (committed.length > 0) {
    git(dir, ['add', '--', ...committed]);
    git(dir, ['commit', '-q', '-m', 'perf: work on your branch']);
  }

  return { root: dir, head: git(dir, ['rev-parse', 'HEAD']).trim(), edited };
}

/** Where a pull request's first change to a file lands, as a 0-based line in your copy. */
function hunkLine(dir: string, head: string, prNumber: number, path: string): number | undefined {
  const base = tryGit(dir, ['merge-base', head, `refs/pull/${prNumber}/head`])?.trim();
  if (!base) return undefined;
  const diff = tryGit(dir, ['diff', '-U0', '--no-color', base, `refs/pull/${prNumber}/head`, '--', path]);
  const match = diff ? /^@@ -(\d+)/m.exec(diff) : null;
  return match ? Math.max(0, Number(match[1]) - 1) : undefined;
}

const BINARY = /\.(png|jpe?g|gif|ico|webp|bmp|pdf|zip|gz|tgz|woff2?|ttf|eot|otf|mp[34]|wasm|jar|exe|dll|so|dylib|bin)$/i;

function isText(path: string): boolean {
  return !BINARY.test(path);
}

// --- Other builds ----------------------------------------------------------------------

/**
 * A checkout of the extension at another ref, for measuring an older build.
 *
 * A worktree in the cache, sharing this project's `node_modules` through a junction. Only
 * `src/` is loaded from it; the harness and the VS Code stub always come from here, so the
 * two builds are measured by exactly the same instrument.
 */
export function sourceRoot(ref: string | undefined, log: (line: string) => void): string {
  if (!ref) return PROJECT_ROOT;

  const dir = join(cacheDir(), 'worktrees', ref.replace(/[^\w.-]+/g, '_'));
  if (!existsSync(dir)) {
    log(`checking out ${ref} into a worktree`);
    git(PROJECT_ROOT, ['worktree', 'add', '--detach', dir, ref]);
  } else {
    git(dir, ['checkout', '-q', '--detach', ref]);
  }
  const modules = join(dir, 'node_modules');
  if (!existsSync(modules)) symlinkSync(join(PROJECT_ROOT, 'node_modules'), modules, 'junction');
  return dir;
}

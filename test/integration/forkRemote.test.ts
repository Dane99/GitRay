/**
 * The fork workflow, against real git.
 *
 * `origin` is your fork; `upstream` is the repository everyone else is opening pull requests
 * against. This is the setup GitRay is most useful in and the one a hardcoded `origin` broke
 * without ever raising an error: `refs/pull/*` does not exist on a fork, so the fetch finds
 * nothing, and a fork's `main` is frozen wherever its last sync left it, so drift measures as
 * zero. Both failures look exactly like a quiet repository.
 *
 * So this builds the real thing — two bare repositories and a clone with both remotes — and
 * asserts on which one the primitives reach, in both directions: what the wrong remote does,
 * and what the right one does instead.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Git, prRef, mainlineRef } from '../../src/providers/git.js';
import { RemoteSelector } from '../../src/providers/remoteSelection.js';

let workspace: string;
let work: string;

const FILE = 'app.ts';

/** The three commits the scenario turns on. */
let shared: string;
let pullRequestHead: string;
let upstreamTip: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
}

function write(cwd: string, marker: string): void {
  const lines = Array.from({ length: 20 }, (_, i) => `const line${i} = ${i};`);
  lines[10] = `const line10 = ${marker};`;
  writeFileSync(join(cwd, FILE), lines.join('\n') + '\n', 'utf8');
}

/** A selector with nothing configured and no gh — the detection path on its own. */
function detected(api: Git): RemoteSelector {
  return new RemoteSelector(api, () => '');
}

before(() => {
  workspace = mkdtempSync(join(tmpdir(), 'gitray-fork-'));
  const upstream = join(workspace, 'upstream.git');
  const fork = join(workspace, 'fork.git');
  const seed = join(workspace, 'seed');
  work = join(workspace, 'work');
  mkdirSync(seed, { recursive: true });

  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', upstream]);
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', fork]);

  git(['init', '-q', '--initial-branch=main'], seed);
  git(['config', 'user.email', 'test@example.invalid'], seed);
  git(['config', 'user.name', 'GitRay Test'], seed);
  git(['config', 'commit.gpgsign', 'false'], seed);
  git(['config', 'core.autocrlf', 'false'], seed);

  write(seed, '0');
  git(['add', '.'], seed);
  git(['commit', '-qm', 'base'], seed);
  shared = git(['rev-parse', 'HEAD'], seed).trim();

  // Both repositories start from the same commit. The fork never moves again — which is
  // exactly what a fork does while its owner works on a branch.
  git(['push', '-q', upstream, 'main'], seed);
  git(['push', '-q', fork, 'main'], seed);

  // A collaborator's pull request, published the way GitHub publishes one: under the base
  // repository's refs/pull/*, and nowhere on the fork.
  git(['checkout', '-q', '-b', 'collab'], seed);
  write(seed, 'THEIRS');
  git(['commit', '-qam', 'collaborator change'], seed);
  pullRequestHead = git(['rev-parse', 'HEAD'], seed).trim();
  git(['push', '-q', upstream, 'HEAD:refs/pull/7/head'], seed);

  // And the mainline moves on, upstream only.
  git(['checkout', '-q', 'main'], seed);
  write(seed, 'UPSTREAM');
  git(['commit', '-qam', 'upstream change'], seed);
  upstreamTip = git(['rev-parse', 'HEAD'], seed).trim();
  git(['push', '-q', upstream, 'main'], seed);

  // The clone a contributor actually has: origin is their fork, upstream added by hand.
  execFileSync('git', ['clone', '-q', fork, work]);
  git(['config', 'user.email', 'test@example.invalid'], work);
  git(['config', 'user.name', 'GitRay Test'], work);
  git(['config', 'commit.gpgsign', 'false'], work);
  git(['config', 'core.autocrlf', 'false'], work);
  git(['remote', 'add', 'upstream', upstream], work);
});

after(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    // Windows may still hold a handle on pack files.
  }
});

test('the pull-request remote is detected as upstream, not origin', async () => {
  assert.equal(await detected(new Git(work)).name(), 'upstream');
});

test('fetching pull request heads from the fork fails, and from upstream works', async () => {
  const api = new Git(work);

  // The old behaviour. GitHub publishes fork heads under the *base* repository, so this ref
  // simply does not exist on `origin` — the whole extension went quiet here.
  await assert.rejects(
    api.fetchPullRequests([7], 'origin'),
    'a fork has no refs/pull/*, and pretending otherwise is the bug'
  );
  assert.equal(await api.refOid(prRef(7)), undefined, 'nothing should have landed');

  const remote = await detected(api).name();
  assert.ok(remote);
  await api.fetchPullRequests([7], remote);

  assert.equal(
    await api.refOid(prRef(7)),
    pullRequestHead,
    'the collaborator’s head should be local now'
  );
});

test('the fork’s mainline is stale, so measuring against it finds no drift', async () => {
  // Asserted so the scenario cannot silently stop reproducing: if the fork were current,
  // nothing below would be proving anything.
  const api = new Git(work);

  const viaFork = await api.mainlineTip('main', 'origin');
  assert.equal(viaFork, shared, 'the fork is still sitting on the commit it was forked at');

  const base = await api.mergeBase(viaFork as string);
  assert.equal(base, viaFork, 'against the fork, HEAD looks perfectly up to date');
  assert.deepEqual(
    await api.commitsIn(base as string, viaFork as string),
    [],
    'and no upstream work is reported at all'
  );
});

test('the mainline fetched from upstream is the one that has moved', async () => {
  const api = new Git(work);
  const remote = await detected(api).name();
  assert.ok(remote);

  await api.fetchMainline('main', remote);

  assert.equal(await api.refOid(mainlineRef('main')), upstreamTip);
  assert.equal(await api.mainlineTip('main', remote), upstreamTip);

  const base = await api.mainlineBase('main', remote);
  assert.equal(base, shared, 'your branch left the mainline at the commit you forked from');

  const commits = await api.commitsIn(base as string, mainlineRef('main'));
  assert.deepEqual(
    commits.map((commit) => commit.subject),
    ['upstream change'],
    'the drift the fork was hiding'
  );
});

test('an explicit gitray.remote overrides detection', async () => {
  const api = new Git(work);
  const selector = new RemoteSelector(api, () => 'origin');

  assert.equal(await selector.name(), 'origin');
});

test('a gitray.remote naming nothing is reported rather than falling back', async () => {
  const choice = await new RemoteSelector(new Git(work), () => 'ustream').choose();

  assert.equal(choice.kind, 'missing');
  assert.equal(choice.kind === 'missing' && choice.name, 'ustream');
});

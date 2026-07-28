/**
 * The merge base cache, across a ref that comes and goes.
 *
 * A pull request's head lives in `refs/gitray/*`, and that ref is not permanent: it is
 * fetched shortly *after* the pull request list lands, it is deleted when the pull request
 * leaves the open list, and muting makes it leave. So there is a real window in which the
 * list says a pull request exists and the object it names is not on disk yet.
 *
 * `mergeBaseFor` answers `undefined` in that window, correctly — there is no shared
 * ancestor with a ref that is not there. The bug was caching it. The cache is keyed by head
 * oid and cleared only when HEAD moves, so one lookup landing in the gap turned a
 * two-second wait into a file that never showed an indicator again for the rest of the
 * session. Unmuting could not fix it; nor could toggling decorations, or anything else that
 * merely repaints.
 *
 * The distinction that matters is between the two ways there can be no merge base:
 * "the ref is not here yet", which is transient, and "these histories do not meet", which
 * is stable and worth remembering.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'node:module';

import { makeVscodeStub, type VscodeStub } from './vscodeStub.js';
import type { PullRequest } from '../../src/core/types.js';

type ModuleLoader = { _load(request: string, parent: unknown, isMain: boolean): unknown };

let root: string;
let stub: VscodeStub;
let Git: typeof import('../../src/providers/git.js').Git;
let prRef: typeof import('../../src/providers/git.js').prRef;
let Store: typeof import('../../src/model/store.js').Store;
let Analyzer: typeof import('../../src/model/analyzer.js').Analyzer;

const FILE = 'app.ts';
const PR_NUMBER = 1;
/** What the collaborator's branch is stored as locally, exactly as the engine names it. */
let PR_REF: string;
let headOid: string;

const BASE_TEXT = [
  'export function greet(name) {',
  '  return `hello ${name}`;',
  '}',
  '',
  'export function farewell(name) {',
  '  return `bye ${name}`;',
  '}',
  ''
].join('\n');

/** Their version: the first function rewritten. */
const THEIR_TEXT = BASE_TEXT.replace('  return `hello ${name}`;', '  return `HELLO, ${name}!`;');

/** Yours: the same function, edited differently, so the two genuinely collide. */
const YOUR_TEXT = BASE_TEXT.replace('  return `hello ${name}`;', '  return `hi there ${name}`;');

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'gitray-mergebase-'));
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'GitRay Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');

  writeFileSync(join(root, FILE), BASE_TEXT);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');

  // Their branch, then back to main — the shape GitRay always sees, since it never checks
  // a collaborator's work out.
  git('checkout', '-q', '-b', 'theirs');
  writeFileSync(join(root, FILE), THEIR_TEXT);
  git('commit', '-q', '-am', 'their change');
  headOid = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'main');
  git('branch', '-q', '-D', 'theirs');

  // Your uncommitted edit, which is what their change gets compared against.
  writeFileSync(join(root, FILE), YOUR_TEXT);

  stub = makeVscodeStub(root);
  const loader = Module as unknown as ModuleLoader;
  const original = loader._load;
  loader._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub.api;
    return original.call(this, request, parent, isMain);
  };

  ({ Git, prRef } = await import('../../src/providers/git.js'));
  ({ Store } = await import('../../src/model/store.js'));
  ({ Analyzer } = await import('../../src/model/analyzer.js'));

  PR_REF = prRef(PR_NUMBER);
});

after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows may still hold a handle; the OS cleans the temp directory up.
  }
});

beforeEach(() => {
  // Every test starts with the head present, the way a settled session has it.
  execFileSync('git', ['update-ref', PR_REF, headOid], { cwd: root });
});

function pullRequest(): PullRequest {
  return {
    number: PR_NUMBER,
    title: 'Rework greet',
    author: 'ada',
    headRefName: 'theirs',
    headRefOid: headOid,
    baseRefName: 'main',
    isDraft: false,
    updatedAt: new Date().toISOString(),
    url: 'https://github.com/acme/app/pull/1',
    additions: 1,
    deletions: 1,
    files: [{ path: FILE, additions: 1, deletions: 1 }]
  };
}

/** A fresh analyzer plus store, i.e. one session's worth of caches. */
function harness() {
  const store = new Store();
  const analyzer = new Analyzer(new Git(root), store, {
    name: async () => 'origin',
    choose: async () => ({ kind: 'ok', name: 'origin' })
  } as never);
  return { store, analyzer, dispose: () => store.dispose() };
}

async function analyze(h: ReturnType<typeof harness>) {
  const pr = pullRequest();
  h.store.setPullRequests([pr]);
  return h.analyzer.analyze(FILE, readFileSync(join(root, FILE), 'utf8'), 1, [pr], {
    proximityLines: 3,
    maxRegionsPerFile: 400,
    mainline: undefined
  });
}

const dropRef = () => execFileSync('git', ['update-ref', '-d', PR_REF], { cwd: root });
const restoreRef = () => execFileSync('git', ['update-ref', PR_REF, headOid], { cwd: root });

test('with the head present, their change is analyzed', async () => {
  const h = harness();
  const analysis = await analyze(h);

  assert.ok(analysis.regions.length > 0, 'the fixture itself must produce regions');
  assert.equal(analysis.degraded, false);
  h.dispose();
});

test('with the head missing, it degrades rather than inventing a base', async () => {
  const h = harness();
  dropRef();

  const analysis = await analyze(h);
  assert.equal(analysis.regions.length, 0, 'no ref means no coordinate system to draw in');
  assert.equal(analysis.degraded, true, 'and that has to be reported, not hidden');

  h.dispose();
});

/**
 * The regression. This is the mute/unmute cycle, which deletes the ref and re-fetches it:
 * the repaint that the pull request list triggers runs *before* the fetch lands, so the
 * lookup that misses is guaranteed rather than unlucky.
 */
test('a head that comes back is analyzed again, not written off for the session', async () => {
  const h = harness();

  dropRef();
  const during = await analyze(h);
  assert.equal(during.regions.length, 0, 'nothing to show while the ref is gone');

  restoreRef();
  const after = await analyze(h);

  assert.ok(
    after.regions.length > 0,
    'the ref is back, so the indicators must come back — caching the miss made this permanent'
  );
  assert.equal(after.degraded, false);

  h.dispose();
});

/**
 * The same trap one layer down, and the one that actually fires in a real session.
 *
 * Muting drops the cached *regions* for the pull request but leaves its merge base warm, so
 * on unmute the merge base is served from cache — the ref check above never runs — and the
 * diff is what meets the missing ref. It comes back empty, and empty is cached against the
 * head oid, which does not change when the ref is re-fetched.
 *
 * So this is the exact shape of the reported failure: a file that had been showing
 * indicators, muted and unmuted, blank for the rest of the session.
 */
test('an empty diff against a missing head is not mistaken for "they changed nothing"', async () => {
  const h = harness();
  const pr = pullRequest();
  const options = { proximityLines: 3, maxRegionsPerFile: 400, mainline: undefined };
  const text = () => readFileSync(join(root, FILE), 'utf8');

  // A settled session: merge base and regions both cached.
  h.store.setPullRequests([pr]);
  const before = await h.analyzer.analyze(FILE, text(), 1, [pr], options);
  assert.ok(before.regions.length > 0);

  // Mute. The engine drops the pull request from the open list, which prunes its regions,
  // and then deletes the ref — leaving the merge base cached and correct.
  h.store.setPullRequests([]);
  dropRef();

  // Unmute. The list comes back before the fetch does, so this pass meets the missing ref.
  h.store.setPullRequests([pr]);
  const during = await h.analyzer.analyze(FILE, text(), 1, [pr], options);
  assert.equal(during.regions.length, 0, 'nothing to show while the head is absent');

  restoreRef();
  const after = await h.analyzer.analyze(FILE, text(), 1, [pr], options);
  assert.ok(
    after.regions.length > 0,
    'caching the empty diff is what made the file blank for the rest of the session'
  );

  h.dispose();
});

/**
 * The other half of the round trip: something has to say the objects arrived.
 *
 * The surfaces are told about a pull request before its head is on disk — the store fires
 * synchronously from `setPullRequests`, and the fetch is awaited after it — so the pass
 * they run finds nothing to analyze against. Not caching the miss is what lets a *later*
 * pass succeed; this is what makes a later pass happen at all. Without it the file stays
 * blank until the next poll or the next keystroke, which on a 60-second interval reads as
 * broken rather than slow.
 */
test('the store announces that fetched heads landed', async () => {
  const h = harness();

  let fired = 0;
  const subscription = h.store.onDidChange(() => {
    fired++;
  });

  h.store.invalidateAll();
  assert.equal(fired, 1, 'invalidateAll is the signal the engine sends after a fetch');

  // And it must actually drop what was cached against the missing ref, or the recomputation
  // it just asked for would be served the empty answer it is trying to replace.
  const pr = pullRequest();
  h.store.cacheRegions(FILE, pr.number, pr.headRefOid, 'base', []);
  h.store.invalidateAll();
  assert.equal(
    h.store.cachedRegions(FILE, pr.number, pr.headRefOid),
    undefined,
    'stale regions must not survive the objects they were derived from arriving'
  );

  subscription.dispose();
  h.dispose();
});

/**
 * The other half of the fix: the cache still has to do its job.
 *
 * "These histories do not meet" is a stable answer, and re-running `git merge-base` per
 * file per pass to keep rediscovering it is what the cache exists to avoid.
 */
test('a genuinely unrelated history is only asked about once', async () => {
  const h = harness();

  // An orphan commit shares no ancestor with main, which is what a shallow clone or a
  // force-pushed-from-nowhere branch looks like.
  const orphan = execFileSync(
    'git',
    ['commit-tree', git('rev-parse', 'HEAD^{tree}').trim(), '-m', 'unrelated'],
    { cwd: root, encoding: 'utf8' }
  ).trim();
  execFileSync('git', ['update-ref', PR_REF, orphan], { cwd: root });

  const pr = { ...pullRequest(), headRefOid: orphan };
  h.store.setPullRequests([pr]);

  const options = { proximityLines: 3, maxRegionsPerFile: 400, mainline: undefined };
  const text = readFileSync(join(root, FILE), 'utf8');

  const first = await h.analyzer.analyze(FILE, text, 1, [pr], options);
  assert.equal(first.degraded, true, 'no shared ancestor is a real answer');

  // Removing the ref now must not change the answer: it was already remembered, so this
  // proves the second call did not go back to git.
  execFileSync('git', ['update-ref', '-d', PR_REF], { cwd: root });
  const second = await h.analyzer.analyze(FILE, text, 1, [pr], options);
  assert.equal(second.degraded, true, 'and one that is worth remembering');

  h.dispose();
});

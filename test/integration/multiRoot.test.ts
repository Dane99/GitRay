/**
 * Multi-root workspaces.
 *
 * The gap this closes: GitRay attached to the *first* workspace folder backed by a git
 * repository and stopped there. Everything below that decision — the store, the poll loop,
 * the collision scan, every badge and every diff — was built for that one repository, so a
 * workspace with a service and its client side by side, or a fork checked out next to its
 * upstream, went silent everywhere but one folder. Silently: there was no row, no status,
 * and no log line to say the other repositories existed.
 *
 * These tests run the real bundle against two throwaway repositories and assert the things
 * that cannot be true unless every folder is genuinely attached: two sessions, two head
 * watchers, rows for both, and — the one most likely to rot — a mute in one repository that
 * does not silence the same number in the other.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'node:module';

import { makeVscodeStub, type VscodeStub } from './vscodeStub.js';

const bundlePath = join(__dirname, '..', '..', 'dist', 'extension.js');

type ModuleLoader = { _load(request: string, parent: unknown, isMain: boolean): unknown };

let alpha: string;
let beta: string;
let plain: string;
let stub: VscodeStub;
let extension: { activate: (context: unknown) => Promise<void>; deactivate: () => void };

function makeRepository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });

  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'GitRay Test');
  // The developer's global config may enable commit signing via an external agent, which
  // would fail in a throwaway repository and take the whole test down with it.
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('commit', '-q', '--allow-empty', '-m', 'base');

  return root;
}

before(async () => {
  alpha = makeRepository('gitray-alpha-');
  beta = makeRepository('gitray-beta-');
  // A folder that is not a repository at all. It must be skipped without taking the
  // repositories on either side of it down with it.
  plain = mkdtempSync(join(tmpdir(), 'gitray-plain-'));

  assert.ok(
    existsSync(bundlePath),
    'dist/extension.js is missing — run `npm run bundle` before the tests'
  );

  stub = makeVscodeStub(alpha, plain, beta);

  const loader = Module as unknown as ModuleLoader;
  const original = loader._load;
  loader._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub.api;
    return original.call(this, request, parent, isMain);
  };

  extension = require(bundlePath);
  await extension.activate(stub.context);
  // Activation kicks off a sync per repository against a remote that does not exist.
  // Give them a moment to fail the way they should.
  await new Promise((resolve) => setTimeout(resolve, 1500));
});

after(() => {
  try {
    extension?.deactivate();
  } catch {
    // Reported by the test that exercises it.
  }
  for (const root of [alpha, beta, plain]) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle; the OS cleans the temp directory up.
    }
  }
});

test('attaches to every git folder, not just the first', () => {
  // One head watcher per session is the cheapest proof that two full stacks were built:
  // Scheduler.start creates exactly one, and only a real session ever calls it.
  assert.equal(
    stub.watchedPatterns.length,
    2,
    `expected one head watcher per repository, got ${stub.watchedPatterns.length}`
  );

  const watched = stub.watchedPatterns.map((pattern) => pattern.base);
  assert.ok(
    watched.some((base) => base.startsWith(alpha)),
    'the first repository should be watched'
  );
  assert.ok(
    watched.some((base) => base.startsWith(beta)),
    'the second repository should be watched too — this is the bug'
  );
});

test('a folder that is not a repository is skipped, not fatal', () => {
  assert.deepEqual(stub.errors, [], `activation logged errors: ${stub.errors.join('; ')}`);
  assert.ok(
    !stub.watchedPatterns.some((pattern) => pattern.base.startsWith(plain)),
    'a plain folder has no git directory to watch'
  );
});

/**
 * Restore happens before discovery does.
 *
 * The host calls the deserializer the moment the serializer is registered, which is several
 * git subprocesses before any repository is attached. Reading the session list there finds
 * it empty, and "no repositories" is indistinguishable from "not yet" unless the callback
 * waits — so a Radar tab was thrown away on essentially every reload, single-repository
 * windows included.
 */
test('a restored Radar panel survives a reload rather than being discarded', () => {
  assert.equal(stub.restoredPanels.length, 1, 'the serializer should have been handed a panel');
  assert.equal(
    stub.restoredPanels[0].disposed,
    false,
    'the panel was thrown away before discovery had a chance to find a repository'
  );
  assert.match(
    stub.restoredPanels[0].title,
    /Radar/,
    'and it should have been adopted by a session, which is what sets the title'
  );
});

test('the sidebar reports content rather than claiming there is no repository', () => {
  const view = stub.contextKeys['gitray.view'];
  assert.notEqual(
    view,
    'noRepo',
    'two repositories are attached, so the "not a git repository" welcome must not show'
  );
});

test('muting in one repository does not silence the same number in the other', async () => {
  const mute = stub.registeredCommands.get('gitray.mutePullRequest');
  assert.ok(mute, 'gitray.mutePullRequest was never registered');

  await mute({ root: alpha, prNumber: 412 });

  assert.deepEqual(
    stub.folderSettings[alpha]?.['gitray.mutedPullRequests'],
    [412],
    'the mute belongs to the repository it was made in'
  );
  assert.equal(
    stub.folderSettings[beta]?.['gitray.mutedPullRequests'],
    undefined,
    'the other repository must not inherit it — its #412 is a different pull request'
  );
  assert.equal(
    stub.settings['gitray.mutedPullRequests'],
    undefined,
    'and it must not land in the shared workspace list, which every folder reads'
  );
});

test('diff URIs name their repository, so a shared path cannot be read from the wrong one', async () => {
  const { pullRequestFileUri } = await import('../../src/ui/contentProvider.js');

  const fromAlpha = pullRequestFileUri(alpha, 7, 'src/app.ts').toString();
  const fromBeta = pullRequestFileUri(beta, 7, 'src/app.ts').toString();

  assert.notEqual(
    fromAlpha,
    fromBeta,
    'the same path in two repositories must not collapse to one document'
  );
  assert.match(fromAlpha, /root=/, 'the repository travels with the URI');
});

/**
 * Two folder events in flight at once.
 *
 * Each pass suspends at every `Repository.discover`, and an event arriving in that window
 * used to start a second pass that saw the same folder unattached. Both attached it, the
 * second overwriting the first in the map — leaving a session nothing held a reference to,
 * still polling its remote and still watching HEAD until the window closed. Counting live
 * watchers is what makes an orphan visible, since nothing else about it is observable.
 */
test('overlapping folder changes do not leave an orphaned session behind', async () => {
  const live = () => stub.watchedPatterns.filter((pattern) => !pattern.disposed).length;

  stub.setWorkspaceFolders([alpha, plain]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(live(), 1, 'the second repository should have detached first');

  // Back-to-back, with no await between them: the second event lands while the first pass
  // is still suspended in git.
  stub.setWorkspaceFolders([alpha, plain, beta]);
  stub.setWorkspaceFolders([alpha, plain, beta]);
  await new Promise((resolve) => setTimeout(resolve, 800));

  assert.equal(live(), 2, 'one session per repository, however many events raced');
});

test('removing a folder detaches only that repository', async () => {
  stub.setWorkspaceFolders([alpha, plain]);
  // onDidChangeWorkspaceFolders reconciles asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const disposed = stub.watchedPatterns.filter((pattern) => pattern.disposed);
  assert.ok(
    disposed.some((pattern) => pattern.base.startsWith(beta)),
    'the removed folder should have been torn down'
  );
  assert.ok(
    !disposed.some((pattern) => pattern.base.startsWith(alpha)),
    'the surviving folder keeps running — reconciled, not rebuilt'
  );
});

/**
 * Shutting down while discovery is still running.
 *
 * The folder event and the shutdown land in the same tick, so the pass is suspended in git
 * when `dispose()` walks the session list — and anything it attached afterwards is behind
 * that walk, with nothing left to tear it down. `deactivate` is not only window close: it
 * also runs when the extension is disabled or updated, and the host keeps running through
 * both, so the orphan's poll timer and head watcher would outlive the extension itself.
 */
test('deactivating mid-discovery disposes everything and attaches nothing new', async () => {
  stub.setWorkspaceFolders([alpha, plain, beta]);

  // Deliberately not in the same tick. Deactivating immediately would be caught before the
  // pass even started, which is the easy half; the window that matters is the one *inside*
  // reconcile, after it has begun probing folders and while it is suspended in git.
  await new Promise((resolve) => setTimeout(resolve, 15));
  extension.deactivate();

  // Long enough for the abandoned pass to have resumed and finished had it been going to.
  await new Promise((resolve) => setTimeout(resolve, 800));

  assert.deepEqual(stub.errors, [], `disposal logged errors: ${stub.errors.join('; ')}`);
  assert.ok(
    stub.watchedPatterns.every((pattern) => pattern.disposed),
    'a session attached after disposal keeps polling for the life of the host'
  );
});

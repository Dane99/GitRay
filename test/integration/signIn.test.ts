/**
 * What a poll is allowed to ask the user.
 *
 * The editor-session fallback rests on one promise: GitRay may borrow a session that
 * already exists, but nothing on a timer may ever open a sign-in dialog. A background
 * extension that pops an authentication prompt every sixty seconds is worse than one that
 * quietly does nothing, and the failure mode is invisible in development — a developer who
 * signed in once never sees the dialog their users would.
 *
 * So this drives real sync passes through the real `editorTokenSource()` against the stub's
 * `vscode.authentication`, and asserts on every request that reached it. The interactive
 * path is exercised too, through the command's own entry point, because "polling is silent"
 * is only worth asserting alongside "the explicit sign-in still works".
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { makeVscodeStub, type VscodeStub } from './vscodeStub.js';

type ModuleLoader = { _load(request: string, parent: unknown, isMain: boolean): unknown };

const ROOT = '/repo';
const realFetch = globalThis.fetch;

let stub: VscodeStub;
let Store: typeof import('../../src/model/store.js').Store;
let SyncEngine: typeof import('../../src/sync/engine.js').SyncEngine;
let GitHub: typeof import('../../src/providers/github.js').GitHub;
let RemoteSelector: typeof import('../../src/providers/remoteSelection.js').RemoteSelector;
let editorTokenSource: typeof import('../../src/providers/session.js').editorTokenSource;
let signIn: typeof import('../../src/providers/session.js').signIn;
let readConfig: typeof import('../../src/core/config.js').readConfig;

before(async () => {
  stub = makeVscodeStub(ROOT);
  const loader = Module as unknown as ModuleLoader;
  const original = loader._load;
  loader._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub.api;
    return original.call(this, request, parent, isMain);
  };

  ({ Store } = await import('../../src/model/store.js'));
  ({ SyncEngine } = await import('../../src/sync/engine.js'));
  ({ GitHub } = await import('../../src/providers/github.js'));
  ({ RemoteSelector } = await import('../../src/providers/remoteSelection.js'));
  ({ editorTokenSource, signIn } = await import('../../src/providers/session.js'));
  ({ readConfig } = await import('../../src/core/config.js'));
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  stub.sessionRequests.length = 0;
  stub.githubSession = undefined;
  probed = [];
});

/** Which repository each probe asked about, so a settled transport can be shown to re-probe. */
let probed: string[] = [];

/** A GitHub that answers a probe and a list, and records which repository was asked. */
function stubEndpoint(): void {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables?: { owner?: string; name?: string };
    };
    if (body.query.includes('GitRayProbe')) {
      probed.push(`${body.variables?.owner}/${body.variables?.name}`);
    }
    const data = body.query.includes('GitRayProbe')
      ? { viewer: { login: 'dane' }, repository: { nameWithOwner: 'Dane99/GitRay' } }
      : {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: 42,
                  title: 'Widen the radar',
                  author: { login: 'rita' },
                  headRefName: 'radar',
                  headRefOid: 'c'.repeat(40),
                  baseRefName: 'main',
                  isDraft: false,
                  updatedAt: '2026-07-26T09:00:00Z',
                  url: 'https://github.com/Dane99/GitRay/pull/42',
                  additions: 4,
                  deletions: 2,
                  files: { nodes: [{ path: 'src/radar/panel.ts', additions: 4, deletions: 2 }] }
                }
              ]
            }
          }
        };

    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
}

/** A machine with no gh at all — the case the fallback exists for. */
const noCli = {
  probe: async () => ({ kind: 'missing' }),
  isInstalled: async () => false
} as never;

/**
 * Just enough repository for a sync pass.
 *
 * The git side is stubbed to bow out early — a shallow clone — so that what remains under
 * test is the metadata call and nothing else. One selector, shared between the engine and
 * the GitHub client exactly as `Repository` shares it, because a test with two of them could
 * not catch the two disagreeing.
 */
function harness(
  options: { remotes?: Record<string, string>; configured?: () => string } = {}
) {
  const store = new Store();
  const urls = options.remotes ?? { origin: 'git@github.com:Dane99/GitRay.git' };
  const git = {
    headSha: async () => 'head1',
    remotes: async () => Object.keys(urls),
    remoteUrl: async (name: string) => urls[name],
    defaultBranch: async () => undefined,
    isShallow: async () => true,
    deleteRefs: async () => {}
  };
  const remotes = new RemoteSelector(git as never, options.configured ?? (() => ''));
  const github = new GitHub(ROOT, git as never, editorTokenSource(), noCli, remotes);

  const repository = {
    root: ROOT,
    folder: { uri: (stub.api.Uri as { file(p: string): unknown }).file(ROOT), name: 'repo', index: 0 },
    git,
    github,
    remotes
  } as never;

  const engine = new SyncEngine(repository, store, { reset: () => {} } as never);
  return { store, engine, sync: () => engine.sync(readConfig()) };
}

test('a poll with no session asks silently, gives up, and offers the sign-in', async () => {
  stubEndpoint();
  const { store, sync } = harness();

  await sync();
  await sync();

  assert.equal(store.currentStatus().reason, 'signed-out');
  assert.ok(stub.sessionRequests.length > 0, 'the editor session was never consulted');
  assert.deepEqual(
    stub.sessionRequests.filter((request) => request.interactive),
    [],
    'a poll must never open a sign-in dialog'
  );
});

test('a poll with a session uses it, and still never asks', async () => {
  stubEndpoint();
  stub.githubSession = { accessToken: 'token-value', account: { label: 'dane' } };
  const { store, sync } = harness();

  await sync();

  assert.deepEqual(
    store.allPullRequests().map((pr) => pr.number),
    [42],
    'the editor session should have carried the metadata call'
  );
  assert.deepEqual(
    stub.sessionRequests.filter((request) => request.interactive),
    [],
    'a poll must never open a sign-in dialog, session or no session'
  );
});

test('the session is requested from the GitHub provider, with the scope private repositories need', async () => {
  stubEndpoint();
  const { sync } = harness();

  await sync();

  const [request] = stub.sessionRequests;
  assert.ok(request, 'no session request was made');
  assert.equal(request.providerId, 'github');
  assert.deepEqual(request.scopes, ['repo']);
});

test('signing in explicitly is the one path that may open a dialog', async () => {
  stub.githubSession = { accessToken: 'token-value', account: { label: 'dane' } };

  assert.equal(await signIn(), true);

  assert.deepEqual(
    stub.sessionRequests.map((request) => request.interactive),
    [true],
    'the explicit command must ask, and must be the only thing that does'
  );
});

test('a dismissed sign-in is an answer, not a failure', async () => {
  // The editor *rejects* when the user closes the dialog. Nothing may throw out of that:
  // the sidebar row stays and the next poll carries on silently.
  stub.githubSession = undefined;

  assert.equal(await signIn(), false);
  assert.deepEqual(stub.sessionRequests.map((request) => request.interactive), [true]);
});

test('repointing the remote re-probes instead of listing the old repository', async () => {
  // The probe normally runs once a session, which was safe when the repository came from a
  // parsed `origin`. `gitray.remote` is live: the ref fetch follows it on the very next pass,
  // so a probe left alone would leave pull requests listed from one repository and their
  // heads fetched from another — the split this whole change exists to close.
  stubEndpoint();
  stub.githubSession = { accessToken: 'token-value', account: { label: 'dane' } };

  let configured = 'origin';
  const { sync } = harness({
    remotes: {
      origin: 'git@github.com:dane/GitRay.git',
      upstream: 'git@github.com:Dane99/GitRay.git'
    },
    configured: () => configured
  });

  await sync();
  await sync();
  assert.deepEqual(probed, ['dane/GitRay'], 'a settled transport must not re-probe for nothing');

  configured = 'upstream';
  await sync();

  assert.deepEqual(probed, ['dane/GitRay', 'Dane99/GitRay']);
});

test('a poll after signing in picks the session up without a reload', async () => {
  stubEndpoint();
  const { store, sync } = harness();

  await sync();
  assert.equal(store.currentStatus().reason, 'signed-out');

  stub.githubSession = { accessToken: 'token-value', account: { label: 'dane' } };
  await sync();

  assert.deepEqual(
    store.allPullRequests().map((pr) => pr.number),
    [42],
    'the engine must re-probe while degraded rather than latching the failure'
  );
});

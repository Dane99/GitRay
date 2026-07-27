/**
 * Choosing a transport.
 *
 * The `gh` CLI used to be a hard requirement, and this is the seam that removed it: when gh
 * is absent or logged out, the editor's own GitHub session answers the same question. What
 * matters is not that either transport works in isolation — that is covered elsewhere — but
 * that the *choice* is right, because every wrong branch here is either a working install
 * told to go and install a CLI, or an Enterprise user quietly pointed at github.com.
 *
 * The GraphQL endpoint is stubbed by swapping the global `fetch`; nothing reaches a network.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { makeVscodeStub, type VscodeStub } from './vscodeStub.js';
import type { GhState } from '../../src/providers/gh.js';
import type { GitHub as GitHubClass } from '../../src/providers/github.js';

type ModuleLoader = { _load(request: string, parent: unknown, isMain: boolean): unknown };

let stub: VscodeStub;
let GitHub: typeof GitHubClass;
const realFetch = globalThis.fetch;

/** Requests the stubbed endpoint received, so "one request per poll" stays testable. */
let requests: { authorization: string; query: string }[] = [];

before(async () => {
  stub = makeVscodeStub(process.cwd());
  const loader = Module as unknown as ModuleLoader;
  const original = loader._load;
  loader._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub.api;
    return original.call(this, request, parent, isMain);
  };

  ({ GitHub } = await import('../../src/providers/github.js'));
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  requests = [];
});

/** A GitHub that answers every query with one open pull request. */
function stubEndpoint(): void {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body)) as { query: string };
    requests.push({ authorization: headers.authorization, query: body.query });

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

/** A gh that reports whatever state a test needs, and refuses to be used for anything else. */
function fakeCli(state: GhState) {
  return {
    probe: async () => state,
    isInstalled: async () => state.kind !== 'missing',
    listPullRequests: async () => {
      throw new Error('the CLI transport must not be used here');
    }
  } as never;
}

function fakeGit(remoteUrl: string | undefined) {
  return { remoteUrl: async () => remoteUrl } as never;
}

const signedIn = { getToken: async () => 'token-value' };
const signedOut = { getToken: async () => undefined };

const ORIGIN = 'git@github.com:Dane99/GitRay.git';

test('a missing gh falls through to the editor session', async () => {
  stubEndpoint();
  const github = new GitHub('/repo', fakeGit(ORIGIN), signedIn, fakeCli({ kind: 'missing' }));

  const state = await github.probe();

  assert.equal(state.kind, 'ok');
  assert.equal(state.kind === 'ok' && state.transport, 'api');
  assert.equal(state.kind === 'ok' && state.login, 'dane');
  assert.equal(state.kind === 'ok' && state.nameWithOwner, 'Dane99/GitRay');

  const pullRequests = await github.listPullRequests(30, false);
  assert.deepEqual(
    pullRequests.map((pr) => pr.number),
    [42]
  );
  assert.equal(requests.length, 2, 'a probe and a list, one request each');
  assert.equal(requests[1].authorization, 'Bearer token-value');
});

test('a logged-out gh falls through too, rather than blocking on `gh auth login`', async () => {
  stubEndpoint();
  const github = new GitHub(
    '/repo',
    fakeGit(ORIGIN),
    signedIn,
    fakeCli({ kind: 'unauthenticated' })
  );

  assert.equal((await github.probe()).kind, 'ok');
});

test('an installed, logged-in gh keeps the job', async () => {
  // gh knows about host config, Enterprise, and fork base repositories, and it costs GitRay
  // no permission at all. It stays the preferred transport when it is there.
  globalThis.fetch = (async () => {
    throw new Error('the API transport must not be used when gh can answer');
  }) as typeof fetch;

  const github = new GitHub(
    '/repo',
    fakeGit(ORIGIN),
    signedIn,
    fakeCli({ kind: 'ok', login: 'dane', nameWithOwner: 'Dane99/GitRay' })
  );

  const state = await github.probe();
  assert.equal(state.kind === 'ok' && state.transport, 'cli');
});

test('gh being offline is final: the API would fail the same way', async () => {
  globalThis.fetch = (async () => {
    throw new Error('a network that is down for gh is down for everyone');
  }) as typeof fetch;

  const github = new GitHub(
    '/repo',
    fakeGit(ORIGIN),
    signedIn,
    fakeCli({ kind: 'offline', message: 'dial tcp: lookup api.github.com' })
  );

  const state = await github.probe();
  assert.equal(state.kind, 'offline');
});

test('no session and no gh asks the user to sign in, and says it can', async () => {
  stubEndpoint();
  const github = new GitHub('/repo', fakeGit(ORIGIN), signedOut, fakeCli({ kind: 'missing' }));

  const state = await github.probe();

  assert.equal(state.kind, 'signed-out');
  assert.equal(state.kind === 'signed-out' && state.canSignIn, true);
  assert.equal(requests.length, 0, 'no token means nothing should reach the network');
});

test('an Enterprise host still needs gh, and says so instead of offering a useless sign-in', async () => {
  // The editor's built-in provider issues github.com tokens only. Offering its sign-in here
  // would send the user through a dialog that cannot possibly help.
  stubEndpoint();
  const github = new GitHub(
    '/repo',
    fakeGit('git@github.acme-corp.example:platform/api.git'),
    signedIn,
    fakeCli({ kind: 'missing' })
  );

  const state = await github.probe();

  assert.equal(state.kind, 'signed-out');
  assert.equal(state.kind === 'signed-out' && state.canSignIn, false);
  assert.match(state.kind === 'signed-out' ? state.message : '', /gh/);
  assert.equal(requests.length, 0, 'an Enterprise remote must never be sent to api.github.com');
});

test('a remote that is not GitHub reports no repository rather than guessing', async () => {
  stubEndpoint();
  const github = new GitHub(
    '/repo',
    fakeGit('/srv/mirrors/app.git'),
    signedIn,
    fakeCli({ kind: 'missing' })
  );

  assert.equal((await github.probe()).kind, 'no-repo');
  assert.equal(requests.length, 0);
});

test('checkout is refused when gh is installed but logged out', async () => {
  // The state the fallback made reachable: gh is on PATH, the editor's session is carrying
  // the extension, and gh would still fail. Asking only whether the executable exists lets
  // the command past the gate and replaces the guidance with gh's raw stderr.
  stubEndpoint();
  const github = new GitHub(
    '/repo',
    fakeGit(ORIGIN),
    signedIn,
    fakeCli({ kind: 'unauthenticated' })
  );

  await github.probe();

  assert.equal(await github.canCheckout(), false);
});

test('checkout is available once gh has answered a probe', async () => {
  globalThis.fetch = (async () => {
    throw new Error('the API transport must not be used when gh can answer');
  }) as typeof fetch;
  const github = new GitHub(
    '/repo',
    fakeGit(ORIGIN),
    signedIn,
    fakeCli({ kind: 'ok', login: 'dane', nameWithOwner: 'Dane99/GitRay' })
  );

  await github.probe();

  assert.equal(await github.canCheckout(), true);
});

test('checkout asked about before the first sync probes gh rather than guessing', async () => {
  const github = new GitHub('/repo', fakeGit(ORIGIN), signedIn, fakeCli({ kind: 'missing' }));

  assert.equal(await github.canCheckout(), false, 'no transport has settled yet');
});

test('a pull request url can be derived without asking anyone', async () => {
  stubEndpoint();
  const github = new GitHub('/repo', fakeGit(ORIGIN), signedIn, fakeCli({ kind: 'missing' }));
  await github.probe();

  assert.equal(github.pullRequestUrl(42), 'https://github.com/Dane99/GitRay/pull/42');
});

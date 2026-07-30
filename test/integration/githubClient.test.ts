/**
 * Deciding who to ask, and whether we can ask at all.
 *
 * There is one transport now — the GitHub session the editor holds — so what is left to get
 * wrong is everything around it: *which* repository the token is spent on, and which hosts
 * the editor can speak for. Both fail quietly when they fail. A repository read from the
 * wrong remote answers with somebody else's pull requests, and an Enterprise remote sent to
 * api.github.com either 404s or, worse, finds a public repository of the same name.
 *
 * The GraphQL endpoint is stubbed by swapping the global `fetch`; nothing reaches a network.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { makeVscodeStub, type VscodeStub } from './vscodeStub.js';
import type { GitHub as GitHubClass } from '../../src/providers/github.js';

type ModuleLoader = { _load(request: string, parent: unknown, isMain: boolean): unknown };

let stub: VscodeStub;
let GitHub: typeof GitHubClass;
const realFetch = globalThis.fetch;

/** Requests the stubbed endpoint received, so "one request per poll" stays testable. */
let requests: {
  url: string;
  authorization: string;
  query: string;
  owner?: string;
  name?: string;
}[] = [];

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
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables?: { owner?: string; name?: string };
    };
    requests.push({
      url,
      authorization: headers.authorization,
      query: body.query,
      // Which repository was asked about, as opposed to what the stub chooses to answer.
      owner: body.variables?.owner,
      name: body.variables?.name
    });

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

/** A repository with one remote, whatever it is named, pointing wherever the test says. */
function fakeGit(remoteUrl: string | undefined, name = 'origin') {
  return {
    remotes: async () => (remoteUrl ? [name] : []),
    remoteUrl: async () => remoteUrl
  } as never;
}

/** A token source that speaks for whichever hosts a test names, and no others. */
function tokens(token: string | undefined, hosts: string[] = ['github.com']) {
  return {
    supports: (host: string) => hosts.includes(host),
    getToken: async () => token
  };
}

const signedIn = tokens('token-value');
const signedOut = tokens(undefined);

const ORIGIN = 'git@github.com:Dane99/GitRay.git';

test('the editor session carries the probe and the list, one request each', async () => {
  stubEndpoint();
  const github = new GitHub(fakeGit(ORIGIN), signedIn);

  const state = await github.probe();

  assert.equal(state.kind, 'ok');
  assert.equal(state.kind === 'ok' && state.login, 'dane');
  assert.equal(state.kind === 'ok' && state.nameWithOwner, 'Dane99/GitRay');

  const pullRequests = await github.listPullRequests(30, false);
  assert.deepEqual(
    pullRequests.map((pr) => pr.number),
    [42]
  );
  assert.equal(requests.length, 2, 'a probe and a list, one request each');
  assert.equal(requests[1].authorization, 'Bearer token-value');
  assert.equal(requests[0].url, 'https://api.github.com/graphql');
});

test('no session asks the user to sign in, and says it can', async () => {
  stubEndpoint();
  const github = new GitHub(fakeGit(ORIGIN), signedOut);

  const state = await github.probe();

  assert.equal(state.kind, 'signed-out');
  assert.equal(state.kind === 'signed-out' && state.canSignIn, true);
  assert.equal(requests.length, 0, 'no token means nothing should reach the network');
});

test('an Enterprise host the editor has no provider for is named, not offered a sign-in', async () => {
  // Offering the sign-in row here would send the user through a dialog that cannot possibly
  // help: the editor registers its Enterprise provider only once `github-enterprise.uri`
  // names the server, so the message has to name the setting instead.
  stubEndpoint();
  const github = new GitHub(
    fakeGit('git@github.acme-corp.example:platform/api.git'),
    tokens('token-value')
  );

  const state = await github.probe();

  assert.equal(state.kind, 'signed-out');
  assert.equal(state.kind === 'signed-out' && state.canSignIn, false);
  assert.match(state.kind === 'signed-out' ? state.message : '', /github-enterprise\.uri/);
  assert.equal(requests.length, 0, 'an Enterprise remote must never be sent to api.github.com');
});

test('a configured Enterprise host is asked on its own server', async () => {
  // The whole point of carrying the host this far: github.com serves GraphQL from a separate
  // `api.` domain, and every Enterprise install serves it from `/api` on itself.
  stubEndpoint();
  const github = new GitHub(
    fakeGit('git@github.acme-corp.example:platform/api.git'),
    tokens('enterprise-token', ['github.acme-corp.example'])
  );

  const state = await github.probe();

  assert.equal(state.kind, 'ok');
  assert.equal(requests[0].url, 'https://github.acme-corp.example/api/graphql');
  assert.equal(requests[0].authorization, 'Bearer enterprise-token');
  assert.deepEqual([requests[0].owner, requests[0].name], ['platform', 'api']);
});

test('a remote that is not GitHub reports no repository rather than guessing', async () => {
  stubEndpoint();
  const github = new GitHub(fakeGit('/srv/mirrors/app.git'), signedIn);

  assert.equal((await github.probe()).kind, 'no-repo');
  assert.equal(requests.length, 0);
});

test('a typo in gitray.remote is reported as itself, not as "no GitHub repository"', async () => {
  // Sync degrades at the probe and never reaches the ref fetch that would otherwise have
  // named the setting. Saying "no GitHub repository" here sends whoever wrote it looking at
  // their remotes instead of at the line they just typed.
  stubEndpoint();
  const { RemoteSelector } = await import('../../src/providers/remoteSelection.js');
  const git = fakeGit(ORIGIN);
  const github = new GitHub(git, signedIn, new RemoteSelector(git, () => 'upstrem'));

  const state = await github.probe();

  assert.equal(state.kind, 'no-repo');
  assert.match(state.kind === 'no-repo' ? state.message : '', /gitray\.remote/);
  assert.match(state.kind === 'no-repo' ? state.message : '', /upstrem/);
  assert.equal(requests.length, 0, 'nothing should reach the network with no remote settled');
});

test('repointing gitray.remote moves the metadata too, without a reload', async () => {
  // The split this guards: the sync engine picks the settings change up immediately and
  // starts fetching refs from the new remote, so a repository cached from the old one would
  // leave pull requests listed from one repository and their heads fetched from another.
  stubEndpoint();
  const { RemoteSelector } = await import('../../src/providers/remoteSelection.js');
  const git = {
    remotes: async () => ['origin', 'upstream'],
    remoteUrl: async (name: string) =>
      name === 'origin' ? 'git@github.com:dane/GitRay.git' : ORIGIN
  } as never;

  let configured = 'origin';
  const github = new GitHub(git, signedIn, new RemoteSelector(git, () => configured));

  assert.equal((await github.probe()).kind, 'ok');
  assert.deepEqual([requests[0].owner, requests[0].name], ['dane', 'GitRay']);
  assert.equal(await github.pullRequestUrl(1), 'https://github.com/dane/GitRay/pull/1');

  configured = 'upstream';
  assert.equal((await github.probe()).kind, 'ok');

  assert.deepEqual(
    [requests[1].owner, requests[1].name],
    ['Dane99', 'GitRay'],
    'the probe must follow the remote rather than reuse the repository it cached'
  );
  assert.equal(await github.pullRequestUrl(1), 'https://github.com/Dane99/GitRay/pull/1');
});

test('a pull request url can be derived without asking anyone', async () => {
  // Deliberately without a probe: this is the path for a number typed into the palette on a
  // machine that has never signed in, and it must not need one.
  const github = new GitHub(fakeGit(ORIGIN), signedOut);

  assert.equal(await github.pullRequestUrl(42), 'https://github.com/Dane99/GitRay/pull/42');
});

test('an Enterprise pull request url stays on the Enterprise host', async () => {
  const github = new GitHub(fakeGit('git@github.acme-corp.example:platform/api.git'), signedOut);

  assert.equal(
    await github.pullRequestUrl(7),
    'https://github.acme-corp.example/platform/api/pull/7'
  );
});

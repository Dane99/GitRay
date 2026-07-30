/**
 * Reading what GitHub sends back.
 *
 * Everything here runs against a fake `fetch`, because the point is not that GitHub works —
 * it is that GitRay turns each of its answers into a definite record, and every failure into
 * a state the sidebar knows how to explain. A signed-out user who is told "offline" goes
 * looking for a network problem they do not have.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubApi, GitHubApiError, type TokenSource } from '../../src/providers/githubApi.js';
import type { RemoteRepository } from '../../src/providers/remote.js';

const repo: RemoteRepository = {
  host: 'github.com',
  owner: 'Dane99',
  name: 'GitRay',
  nameWithOwner: 'Dane99/GitRay'
};

const signedIn: TokenSource = { supports: () => true, getToken: async () => 'token-value' };
const signedOut: TokenSource = { supports: () => true, getToken: async () => undefined };

interface Captured {
  body: { query: string; variables: Record<string, unknown> };
  headers: Record<string, string>;
}

/** A fetch that answers with one payload and records what it was asked. */
function respond(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): { fetch: (url: string, options: RequestInit) => Promise<Response>; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: async (_url, options) => {
      calls.push({
        body: JSON.parse(String(options.body)),
        headers: options.headers as Record<string, string>
      });
      return new Response(JSON.stringify(payload), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json', ...init.headers }
      });
    }
  };
}

function api(
  transport: ReturnType<typeof respond>,
  tokens: TokenSource = signedIn
): GitHubApi {
  return new GitHubApi(repo, tokens, transport.fetch);
}

test('a probe asks for the viewer and the repository in one request', async () => {
  const transport = respond({
    data: { viewer: { login: 'dane' }, repository: { nameWithOwner: 'Dane99/GitRay' } }
  });

  const state = await api(transport).probe();

  assert.deepEqual(state, { login: 'dane', nameWithOwner: 'Dane99/GitRay' });
  assert.equal(transport.calls.length, 1, 'a probe must cost exactly one request');
  assert.equal(transport.calls[0].headers.authorization, 'Bearer token-value');
  assert.deepEqual(transport.calls[0].body.variables, { owner: 'Dane99', name: 'GitRay' });
});

test('a pull request arrives as a definite record, whatever GraphQL nested it in', async () => {
  const transport = respond({
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 7,
              title: '  Tidy the parser  ',
              author: { login: 'rita' },
              headRefName: 'tidy-parser',
              headRefOid: 'a'.repeat(40),
              baseRefName: 'main',
              isDraft: false,
              updatedAt: '2026-07-20T10:00:00Z',
              url: 'https://github.com/Dane99/GitRay/pull/7',
              additions: 12,
              deletions: 3,
              files: { nodes: [{ path: 'src/a.ts', additions: 12, deletions: 3 }] }
            }
          ]
        }
      }
    }
  });

  const [pr] = await api(transport).listPullRequests(30, false);

  assert.equal(pr.number, 7);
  assert.equal(pr.title, 'Tidy the parser', 'titles are trimmed');
  assert.equal(pr.author, 'rita');
  // The nested `files.nodes` is GraphQL's shape; the model must never see it.
  assert.deepEqual(pr.files, [{ path: 'src/a.ts', additions: 12, deletions: 3 }]);
  // Absent head-repository fields must read as "not a fork, not pushable" rather than as
  // undefined: checkout branches on them, and undefined would wire a branch to the wrong
  // place on any response that happened to omit them.
  assert.equal(pr.isCrossRepository, false);
  assert.equal(pr.maintainerCanModify, false);
  assert.equal(pr.headRepositoryUrl, undefined);
});

test('a fork pull request carries where its branch lives, for checkout', async () => {
  const transport = respond({
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 8,
              title: 'From a fork',
              author: { login: 'rita' },
              headRefName: 'patch-1',
              headRefOid: 'b'.repeat(40),
              baseRefName: 'main',
              isDraft: false,
              updatedAt: '2026-07-21T10:00:00Z',
              url: 'https://github.com/Dane99/GitRay/pull/8',
              additions: 1,
              deletions: 0,
              isCrossRepository: true,
              maintainerCanModify: true,
              headRepository: { url: 'https://github.com/rita/GitRay' },
              files: { nodes: [{ path: 'src/a.ts', additions: 1, deletions: 0 }] }
            }
          ]
        }
      }
    }
  });

  const [pr] = await api(transport).listPullRequests(30, false);

  assert.equal(pr.isCrossRepository, true);
  assert.equal(pr.maintainerCanModify, true);
  assert.equal(pr.headRepositoryUrl, 'https://github.com/rita/GitRay');
});

test('a deleted fork leaves no push target rather than an empty one', async () => {
  // GitHub nulls `headRepository` once the fork is gone. An empty string here would be
  // handed to `git config branch.x.remote` and configure a branch that pushes nowhere.
  const transport = respond({
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 9,
              title: 'Fork since deleted',
              author: { login: 'rita' },
              headRefName: 'patch-2',
              headRefOid: 'c'.repeat(40),
              baseRefName: 'main',
              isDraft: false,
              updatedAt: '2026-07-22T10:00:00Z',
              url: 'https://github.com/Dane99/GitRay/pull/9',
              additions: 1,
              deletions: 0,
              isCrossRepository: true,
              maintainerCanModify: true,
              headRepository: null,
              files: { nodes: [{ path: 'src/a.ts', additions: 1, deletions: 0 }] }
            }
          ]
        }
      }
    }
  });

  const [pr] = await api(transport).listPullRequests(30, false);

  assert.equal(pr.headRepositoryUrl, undefined);
});

test('drafts are excluded unless asked for, and the rest sort by most recently updated', async () => {
  const node = (number: number, updatedAt: string, isDraft: boolean) => ({
    number,
    title: `#${number}`,
    author: { login: 'sam' },
    headRefName: `branch-${number}`,
    headRefOid: String(number).repeat(40),
    baseRefName: 'main',
    isDraft,
    updatedAt,
    url: '',
    additions: 1,
    deletions: 0,
    files: { nodes: [{ path: 'a.ts', additions: 1, deletions: 0 }] }
  });

  const payload = {
    data: {
      repository: {
        pullRequests: {
          nodes: [
            node(1, '2026-07-01T00:00:00Z', false),
            node(2, '2026-07-26T00:00:00Z', true),
            node(3, '2026-07-25T00:00:00Z', false)
          ]
        }
      }
    }
  };

  assert.deepEqual(
    (await api(respond(payload)).listPullRequests(30, false)).map((pr) => pr.number),
    [3, 1]
  );
  assert.deepEqual(
    (await api(respond(payload)).listPullRequests(30, true)).map((pr) => pr.number),
    [2, 3, 1]
  );
});

test('records missing a number or a head commit are dropped, not defaulted', async () => {
  // Both are how GitRay names a pull request to git. A placeholder for either would put
  // indicators on lines computed against nothing.
  const transport = respond({
    data: {
      repository: {
        pullRequests: {
          nodes: [
            { number: 1, headRefOid: undefined, files: { nodes: [] } },
            { number: undefined, headRefOid: 'b'.repeat(40), files: { nodes: [] } },
            null
          ]
        }
      }
    }
  });

  assert.deepEqual(await api(transport).listPullRequests(30, true), []);
});

test('no session reads as signed out, before any request is made', async () => {
  const transport = respond({ data: {} });

  const error = await api(transport, signedOut)
    .probe()
    .catch((caught: unknown) => caught);

  assert.ok(error instanceof GitHubApiError);
  assert.equal(error.kind, 'signed-out');
  assert.equal(transport.calls.length, 0, 'a missing token must not reach the network');
});

test('a rejected token reads as signed out rather than offline', async () => {
  const transport = respond({ message: 'Bad credentials' }, { status: 401 });

  const error = await api(transport)
    .probe()
    .catch((caught: unknown) => caught);

  assert.ok(error instanceof GitHubApiError);
  assert.equal(error.kind, 'signed-out');
});

test('a repository the account cannot see reads as no-repo, and says why', async () => {
  // GraphQL reports this as HTTP 200 with an errors array, which is exactly the shape a
  // naive client treats as success.
  const transport = respond({
    data: { viewer: { login: 'dane' }, repository: null },
    errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }]
  });

  const error = await api(transport)
    .probe()
    .catch((caught: unknown) => caught);

  assert.ok(error instanceof GitHubApiError);
  assert.equal(error.kind, 'no-repo');
  assert.match(error.message, /Dane99\/GitRay/);
});

test('an exhausted rate limit is reported as a wait, not a failure', async () => {
  const transport = respond(
    { message: 'API rate limit exceeded' },
    { status: 403, headers: { 'x-ratelimit-remaining': '0' } }
  );

  const error = await api(transport)
    .probe()
    .catch((caught: unknown) => caught);

  assert.ok(error instanceof GitHubApiError);
  assert.equal(error.kind, 'offline', 'the scheduler backs off on offline, which is the right move here');
  assert.match(error.message, /rate limit/i);
});

test('a network failure keeps the underlying cause, not just "fetch failed"', async () => {
  const failing = async (): Promise<Response> => {
    throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.github.com') });
  };

  const error = await new GitHubApi(repo, signedIn, failing)
    .probe()
    .catch((caught: unknown) => caught);

  assert.ok(error instanceof GitHubApiError);
  assert.equal(error.kind, 'offline');
  assert.match(error.message, /ENOTFOUND/);
});

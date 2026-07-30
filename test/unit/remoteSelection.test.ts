/**
 * Choosing the remote to fetch from.
 *
 * The failure this guards is silent by construction. Hardcode `origin` and a fork clone
 * still starts, still lists pull requests, and still fetches — from a repository whose
 * `refs/pull/*` is empty and whose `main` is whatever the fork last synced. Nothing errors;
 * there are simply never any indicators. So the assertions here are about *which* remote
 * comes back, and about the one case that must fail loudly rather than fall back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteSelector, preferredRemote } from '../../src/providers/remoteSelection.js';

/** The classic fork clone: your copy on `origin`, the real repository on `upstream`. */
const FORK = {
  origin: 'git@github.com:dane/GitRay.git',
  upstream: 'https://github.com/Dane99/GitRay.git'
};

/** A `Git` that knows nothing but its remotes, which a test may edit as it goes. */
function fakeGit(remotes: Record<string, string>) {
  return {
    remotes: async () => Object.keys(remotes),
    remoteUrl: async (name: string) => remotes[name]
  } as never;
}

function selector(remotes: Record<string, string>, configured = '') {
  return new RemoteSelector(fakeGit(remotes), () => configured);
}

test('prefers upstream over origin, the way the fork convention does', () => {
  assert.equal(preferredRemote(['origin', 'upstream']), 'upstream');
  assert.equal(preferredRemote(['origin', 'github']), 'github');
  assert.equal(preferredRemote(['origin']), 'origin');
  // Neither conventional name present: git lists alphabetically, so this is stable.
  assert.equal(preferredRemote(['fork', 'mirror']), 'fork');
  assert.equal(preferredRemote([]), undefined);
});

test('a plain clone still uses origin', async () => {
  assert.equal(await selector({ origin: FORK.origin }).name(), 'origin');
});

test('a fork clone fetches from upstream, not from your own copy', async () => {
  assert.equal(await selector(FORK).name(), 'upstream');
});

test('gitray.remote overrides the name preference', async () => {
  // The reverse of the convention: `upstream` is somebody's vanity mirror and the pull
  // requests are on `origin`. Nothing can work that out locally, so the setting is the fix.
  assert.equal(await selector(FORK, 'origin').name(), 'origin');
});

test('a gitray.remote naming nothing is reported, not quietly replaced', async () => {
  // Falling back to `origin` here would leave a typo looking exactly like a working setup
  // on a plain clone, and like a broken extension on a fork.
  const choice = await selector(FORK, 'upstrem').choose();

  assert.equal(choice.kind, 'missing');
  assert.equal(choice.kind === 'missing' && choice.name, 'upstrem');
  assert.equal(await selector(FORK, 'upstrem').name(), undefined);
});

test('a repository with no remotes has nothing to choose', async () => {
  const choice = await selector({}).choose();
  assert.equal(choice.kind, 'none');
});

test('a setting change is picked up without a reload', async () => {
  // The selector caches, and a cache keyed on nothing would pin the first answer for the
  // life of the window — settings changes have to survive it.
  let configured = '';
  const selected = new RemoteSelector(fakeGit(FORK), () => configured);

  assert.equal(await selected.name(), 'upstream');
  configured = 'origin';
  assert.equal(await selected.name(), 'origin');
});

test('adding a remote is noticed without a reload', async () => {
  // The fix the failure message sends people to is `git remote add upstream …`, and a cache
  // keyed only on the settings would keep fetching from the fork until the window restarted
  // — with the sidebar still telling them to do the thing they just did.
  const remotes: Record<string, string> = { origin: FORK.origin };
  const selected = selector(remotes);

  assert.equal(await selected.name(), 'origin');

  remotes.upstream = FORK.upstream;
  assert.equal(await selected.name(), 'upstream');

  delete remotes.upstream;
  assert.equal(await selected.name(), 'origin', 'and removing one is noticed too');
});

test('the resolved repository comes from the chosen remote, not from origin', async () => {
  const repository = await selector(FORK).repository();

  assert.equal(repository?.nameWithOwner, 'Dane99/GitRay');
  assert.equal(repository?.host, 'github.com');
});

test('an Enterprise remote keeps its own host rather than collapsing to github.com', async () => {
  // Same `owner/name`, two hosts. Everything downstream — which endpoint is called, which
  // sign-in is offered — turns on this staying distinct.
  const repository = await selector({
    origin: 'git@github.acme-corp.example:acme/api.git'
  }).repository();

  assert.equal(repository?.host, 'github.acme-corp.example');
  assert.equal(repository?.nameWithOwner, 'acme/api');
});

test('a remote that is not a GitHub URL resolves to no repository', async () => {
  assert.equal(await selector({ origin: '/srv/mirrors/app.git' }).repository(), undefined);
});

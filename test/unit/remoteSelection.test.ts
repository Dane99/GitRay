/**
 * Choosing the remote to fetch from.
 *
 * The failure this guards is silent by construction. Hardcode `origin` and a fork clone
 * still starts, still lists pull requests through gh, and still fetches — from a repository
 * whose `refs/pull/*` is empty and whose `main` is whatever the fork last synced. Nothing
 * errors; there are simply never any indicators. So the assertions here are about *which*
 * remote comes back, and about the one case that must fail loudly rather than fall back.
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

/** gh resolved a repository, without saying which host it is on. */
function resolved(nameWithOwner: string, host?: string) {
  return { nameWithOwner, host };
}

function selector(remotes: Record<string, string>, configured = '') {
  return new RemoteSelector(fakeGit(remotes), () => configured);
}

test('prefers upstream over origin, the way gh does', () => {
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

test('what gh resolved wins over the name preference', async () => {
  // The reverse of the convention: `upstream` is somebody's vanity mirror and the pull
  // requests are on `origin`. Names alone would get this wrong; gh's answer does not.
  const remotes = {
    origin: 'git@github.com:Dane99/GitRay.git',
    upstream: 'git@github.com:someone/unrelated.git'
  };
  const selected = selector(remotes);
  selected.setBaseRepository(resolved('Dane99/GitRay'));

  assert.equal(await selected.name(), 'origin');
});

test('gh’s answer is matched case-insensitively, as GitHub treats it', async () => {
  const selected = selector(FORK);
  selected.setBaseRepository(resolved('dane99/gitray'));

  assert.equal(await selected.name(), 'upstream');
});

test('a base repository no remote points at falls back rather than failing here', async () => {
  // `gh repo set-default` elsewhere, or a fork whose parent was never added. There is no
  // right answer locally, so the guess stands — the fetch failing is what says so, and it
  // names the remote when it does.
  const selected = selector({ origin: FORK.origin });
  selected.setBaseRepository(resolved('someone-else/project'));

  assert.equal(await selected.name(), 'origin');
});

test('gitray.remote overrides everything, including gh', async () => {
  const selected = selector(FORK, 'origin');
  selected.setBaseRepository(resolved('Dane99/GitRay'));

  assert.equal(await selected.name(), 'origin');
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

test('learning what gh resolved re-decides an answer already given', async () => {
  // The order real code runs in: the mainline is read before gh has probed, so the first
  // answer is the guess and the second has to be allowed to differ.
  const remotes = {
    origin: 'git@github.com:Dane99/GitRay.git',
    upstream: 'git@github.com:someone/unrelated.git'
  };
  const selected = selector(remotes);

  assert.equal(await selected.name(), 'upstream');
  selected.setBaseRepository(resolved('Dane99/GitRay'));
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

test('an Enterprise mirror is not mistaken for its github.com namesake', async () => {
  // Same `owner/name`, two hosts, and gh resolved the Enterprise one. Comparing names alone
  // would send every ref fetch to the public mirror.
  const remotes = {
    origin: 'git@github.com:acme/api.git',
    upstream: 'git@github.acme-corp.example:acme/api.git'
  };
  const selected = selector(remotes);
  selected.setBaseRepository(resolved('acme/api', 'github.acme-corp.example'));

  assert.equal(await selected.name(), 'upstream');

  const other = selector(remotes);
  other.setBaseRepository(resolved('acme/api', 'github.com'));
  assert.equal(await other.name(), 'origin');
});

test('a gh that reported no host still matches on the name alone', async () => {
  // gh's url is parsed for the host, and a url that does not parse must not make every
  // comparison fail — that would throw away the best input the selector has.
  const selected = selector(FORK);
  selected.setBaseRepository(resolved('Dane99/GitRay'));

  assert.equal(await selected.name(), 'upstream');
});

test('the resolved repository comes from the chosen remote, not from origin', async () => {
  const repository = await selector(FORK).repository();

  assert.equal(repository?.nameWithOwner, 'Dane99/GitRay');
  assert.equal(repository?.host, 'github.com');
});

test('a remote that is not a GitHub URL resolves to no repository', async () => {
  assert.equal(await selector({ origin: '/srv/mirrors/app.git' }).repository(), undefined);
});

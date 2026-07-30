/**
 * Checking out a pull request, against real git.
 *
 * This used to be `gh pr checkout` and is now GitRay's own, which makes it the one operation
 * here that writes outside `refs/gitray/*` and touches the working tree. Two things have to
 * be right and neither shows up as an error when it is not.
 *
 * The first is where the head comes from. A fork's branch has no ref on the base repository,
 * so it can only be fetched from `refs/pull/<n>/head` — the ref GitHub publishes for exactly
 * this. Getting that wrong fails loudly, at least.
 *
 * The second does not. The branch config is what decides where a later `git push` goes, and
 * a branch left wired to the base repository would send a contributor's commits into the
 * base repository under their branch name, which is a mess to undo and looks like nothing at
 * the time. So each of the three cases is asserted on: our own branch, a fork we may push
 * to, and a fork we may not.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Git } from '../../src/providers/git.js';

let workspace: string;
let work: string;
let forkUrl: string;

/** The head commits the pull requests point at. */
let ourHead: string;
let forkHead: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
}

function identify(cwd: string): void {
  git(['config', 'user.email', 'test@example.invalid'], cwd);
  git(['config', 'user.name', 'GitRay Test'], cwd);
  git(['config', 'commit.gpgsign', 'false'], cwd);
  git(['config', 'core.autocrlf', 'false'], cwd);
}

/** What git thinks a branch pushes and pulls from. */
function branchConfig(branch: string): { remote?: string; merge?: string; pushRemote?: string } {
  const read = (key: string): string | undefined => {
    try {
      return git(['config', '--get', `branch.${branch}.${key}`], work).trim();
    } catch {
      return undefined;
    }
  };
  return { remote: read('remote'), merge: read('merge'), pushRemote: read('pushRemote') };
}

before(() => {
  workspace = mkdtempSync(join(tmpdir(), 'gitray-checkout-'));
  const upstream = join(workspace, 'upstream.git');
  forkUrl = join(workspace, 'fork.git');
  const seed = join(workspace, 'seed');
  work = join(workspace, 'work');
  mkdirSync(seed, { recursive: true });

  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', upstream]);
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', forkUrl]);

  git(['init', '-q', '--initial-branch=main'], seed);
  identify(seed);

  writeFileSync(join(seed, 'app.ts'), 'const a = 1;\n', 'utf8');
  git(['add', '.'], seed);
  git(['commit', '-qm', 'base'], seed);
  git(['push', '-q', upstream, 'main'], seed);

  // #1: a branch in the base repository itself. It exists as a real branch *and* under
  // refs/pull, exactly as GitHub publishes one.
  git(['checkout', '-q', '-b', 'ours'], seed);
  writeFileSync(join(seed, 'app.ts'), 'const a = 2;\n', 'utf8');
  git(['commit', '-qam', 'our change'], seed);
  ourHead = git(['rev-parse', 'HEAD'], seed).trim();
  git(['push', '-q', upstream, 'HEAD:refs/heads/ours'], seed);
  git(['push', '-q', upstream, 'HEAD:refs/pull/1/head'], seed);

  // #2: a branch that lives only in somebody's fork. Nothing under refs/heads on the base
  // repository points at it — refs/pull is the only way to reach it.
  git(['checkout', '-q', 'main'], seed);
  git(['checkout', '-q', '-b', 'theirs'], seed);
  writeFileSync(join(seed, 'app.ts'), 'const a = 3;\n', 'utf8');
  git(['commit', '-qam', 'their change'], seed);
  forkHead = git(['rev-parse', 'HEAD'], seed).trim();
  git(['push', '-q', forkUrl, 'HEAD:refs/heads/theirs'], seed);
  git(['push', '-q', upstream, 'HEAD:refs/pull/2/head'], seed);

  // autocrlf at clone time, not after: a Windows machine with it on globally checks the
  // files out as CRLF, and turning it off afterwards leaves every one of them looking
  // modified — which is enough to make `git checkout` refuse.
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', upstream, work]);
  identify(work);
});

after(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    // Windows may still hold a handle on pack files.
  }
});

test('a pull request from this repository tracks its real branch', async () => {
  const api = new Git(work);

  await api.checkoutPullRequest({
    prNumber: 1,
    branch: 'ours',
    remote: 'origin',
    headRefName: 'ours',
    isCrossRepository: false
  });

  assert.equal(await api.headSha(), ourHead);
  assert.equal(await api.currentBranch(), 'ours');
  // The branch is ours to push to, so it tracks itself and nothing is redirected.
  assert.deepEqual(branchConfig('ours'), {
    remote: 'origin',
    merge: 'refs/heads/ours',
    pushRemote: undefined
  });
});

test('a fork’s branch is reachable, and pushes back to the fork when that is allowed', async () => {
  const api = new Git(work);

  await api.checkoutPullRequest({
    prNumber: 2,
    branch: 'theirs',
    remote: 'origin',
    headRefName: 'theirs',
    isCrossRepository: true,
    pushUrl: forkUrl
  });

  assert.equal(await api.headSha(), forkHead, 'refs/pull is the only copy origin has');
  assert.equal(await api.currentBranch(), 'theirs');
  assert.deepEqual(branchConfig('theirs'), {
    remote: forkUrl,
    merge: 'refs/heads/theirs',
    pushRemote: forkUrl
  });
});

test('a fork we may not push to tracks the read-only pull ref instead', async () => {
  const api = new Git(work);
  git(['checkout', '-q', 'main'], work);
  git(['branch', '-qD', 'theirs'], work);

  await api.checkoutPullRequest({
    prNumber: 2,
    branch: 'theirs',
    remote: 'origin',
    headRefName: 'theirs',
    isCrossRepository: true
  });

  // No push target exists, so the branch is wired to the one thing it can legitimately
  // reach. Naming the fork here would turn every `git push` into a permission error.
  assert.deepEqual(branchConfig('theirs'), {
    remote: 'origin',
    merge: 'refs/pull/2/head',
    pushRemote: undefined
  });
});

test('checking out again fast-forwards rather than rewriting the branch', async () => {
  const api = new Git(work);
  git(['checkout', '-q', 'main'], work);

  await api.checkoutPullRequest({
    prNumber: 2,
    branch: 'theirs',
    remote: 'origin',
    headRefName: 'theirs',
    isCrossRepository: true
  });

  assert.equal(await api.headSha(), forkHead);
});

test('an unrelated local branch of the same name is refused before anything moves', async () => {
  // The realistic collision: a fork's branch is called `patch-1` and so is one of yours.
  // Forcing the ref would throw your commit away silently, which is the one outcome a
  // checkout must never produce. Refusing is only half of it — refusing *after* switching
  // would leave you reading the error from a branch you did not ask to be on.
  const api = new Git(work);
  git(['checkout', '-q', 'main'], work);
  git(['checkout', '-q', '-b', 'patch-1'], work);
  writeFileSync(join(work, 'notes.md'), 'mine\n', 'utf8');
  git(['add', '.'], work);
  git(['commit', '-qm', 'unrelated local work'], work);
  const mine = git(['rev-parse', 'HEAD'], work).trim();

  git(['checkout', '-q', 'main'], work);

  await assert.rejects(
    api.checkoutPullRequest({
      prNumber: 2,
      branch: 'patch-1',
      remote: 'origin',
      headRefName: 'patch-1',
      isCrossRepository: true
    }),
    /will not move a branch that would lose work/
  );

  assert.equal(await api.currentBranch(), 'main', 'the user must be left where they were');
  assert.equal(
    git(['rev-parse', 'patch-1'], work).trim(),
    mine,
    'and the local commit must still be there'
  );
});

test('local commits on top of a pull request branch survive a re-checkout', async () => {
  // The other side of the same rule. Being ahead of the pull request is not a conflict —
  // it is the normal state of a maintainer who has pushed a fix onto a contributor's branch
  // — so this has to succeed and leave the extra commit alone.
  const api = new Git(work);
  git(['checkout', '-q', 'theirs'], work);
  writeFileSync(join(work, 'app.ts'), 'const a = 4;\n', 'utf8');
  git(['commit', '-qam', 'a fix on top'], work);
  const ahead = git(['rev-parse', 'HEAD'], work).trim();

  await api.checkoutPullRequest({
    prNumber: 2,
    branch: 'theirs',
    remote: 'origin',
    headRefName: 'theirs',
    isCrossRepository: true
  });

  assert.equal(await api.headSha(), ahead);
});

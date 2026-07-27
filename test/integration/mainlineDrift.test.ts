/**
 * Conflicts with work that has already merged.
 *
 * The gap this closes: GitRay only ever watched *open* pull requests, so the moment a
 * colleague's branch merged it vanished from every surface — at exactly the moment its
 * overlap with your work stopped being hypothetical and started waiting for you at your
 * next rebase. Tracking only what is open means going quiet precisely when the predicted
 * risk becomes real.
 *
 * The fix treats the mainline as one more collaborator. These tests pin down that it
 * detects what merged, that it agrees with what git actually does at rebase time, and —
 * just as importantly — that it stays silent on a clean tree, which is what makes the
 * signal worth anything.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Git, mainlineRef, prRef } from '../../src/providers/git.js';
import { alignLines, splitLines } from '../../src/model/lineMap.js';
import { classifyProximity } from '../../src/model/collision.js';

let workspace: string;
let root: string;
let origin: string;

const FILE = 'app.ts';
const CONTESTED = 10;
const FAR_AWAY = 2;

function git(args: string[], cwd = root): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
}

function baseLines(): string[] {
  return Array.from({ length: 20 }, (_, i) => `const line${i} = ${i};`);
}

function write(lines: string[]): void {
  writeFileSync(join(root, FILE), lines.join('\n') + '\n', 'utf8');
}

/** Replace one line, leaving everything else at its original content. */
function withLine(index: number, text: string): string[] {
  const lines = baseLines();
  lines[index] = text;
  return lines;
}

/**
 * A scenario: your branch left the mainline, then somebody else's pull request merged.
 *
 *   main:   base ──── merged (touches line 10)      ← where the mainline is now
 *              └───── yours                          ← where your branch left it
 *
 * `yours` is deliberately left with no commits of its own, so anything the analysis
 * attributes to you has to come from the working tree — which is what the collision
 * assertions below actually vary.
 */
before(() => {
  workspace = mkdtempSync(join(tmpdir(), 'gitray-mainline-'));
  origin = join(workspace, 'origin.git');
  root = join(workspace, 'work');
  mkdirSync(root, { recursive: true });

  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);

  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'GitRay Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);
  git(['remote', 'add', 'origin', origin]);

  write(baseLines());
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  git(['push', '-q', 'origin', 'main']);

  // You branch off here and stay there for the rest of the test.
  git(['checkout', '-q', '-b', 'yours']);

  // Meanwhile a colleague's pull request merges into main, touching line 10. The subject
  // is shaped the way GitHub's squash merge shapes it, number and all.
  git(['checkout', '-q', 'main']);
  write(withLine(CONTESTED, 'const line10 = MERGED;'));
  git(['commit', '-qam', 'Make line 10 configurable (#412)']);
  git(['push', '-q', 'origin', 'main']);

  git(['checkout', '-q', 'yours']);
  write(baseLines());
});

after(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    // Windows may still hold a handle on pack files.
  }
});

/** Fetch the mainline the way the sync engine does, into GitRay's own namespace. */
async function fetchMainline(): Promise<Git> {
  const api = new Git(root);
  await api.fetchMainline('main');
  return api;
}

/**
 * What GitRay predicts about mainline drift for the current working tree.
 *
 * Deliberately assembled from the same primitives the analyzer uses rather than by calling
 * it: the analyzer needs a vscode module, and the point here is the git-level agreement.
 */
async function predictDrift(api: Git, workingLines: string[]) {
  const tip = await api.mainlineTip('main');
  assert.ok(tip, 'expected a mainline tip');

  const base = await api.mergeBase(tip);
  assert.ok(base, 'expected a mainline base');

  const baseText = await api.showFile(base, FILE);
  assert.ok(baseText !== undefined, 'expected the file to exist at the base');

  const alignment = alignLines(splitLines(baseText), workingLines);
  const diffs = await api.diffRange(base, tip, [FILE]);

  return diffs
    .flatMap((file) => file.hunks)
    .map((hunk) => classifyProximity(hunk.baseRange, alignment.localEdits, 3));
}

/**
 * Ask git for the truth: does rebasing onto the mainline actually conflict?
 *
 * Commits the given content on a scratch branch and attempts the real rebase, then puts
 * the repository back exactly as it was so the next scenario starts clean.
 */
function gitSaysRebaseConflicts(label: string, lines: string[]): boolean {
  git(['checkout', '-q', '-B', `verify-${label}`, 'yours']);
  write(lines);
  git(['commit', '-qam', 'my work']);

  let conflicted = false;
  try {
    git(['rebase', '-q', mainlineRef('main')]);
  } catch {
    conflicted = true;
  }

  try {
    git(['rebase', '--abort']);
  } catch {
    // Nothing to abort when the rebase succeeded outright.
  }

  git(['checkout', '-q', 'yours']);
  git(['reset', '-q', '--hard', 'yours']);
  write(lines);
  return conflicted;
}

test('the mainline is fetched into GitRay\'s namespace, not the user\'s remote-tracking ref', async () => {
  // Advancing refs/remotes/origin/main would make `git status` start reporting a "behind"
  // count the user never asked for. The isolation is the feature, so it is asserted.
  const before = await new Git(root).refOid('refs/remotes/origin/main');

  const api = await fetchMainline();

  assert.ok(await api.refOid(mainlineRef('main')), 'the private mainline ref should exist');
  assert.equal(
    await api.refOid('refs/remotes/origin/main'),
    before,
    'the user\'s remote-tracking ref must be left exactly as it was'
  );
});

test('the mainline has genuinely moved past where your branch left it', async () => {
  // Without this the scenario would not reproduce the gap at all.
  const api = await fetchMainline();

  const tip = await api.mainlineTip('main');
  const base = await api.mergeBase(tip as string);

  assert.ok(tip);
  assert.ok(base);
  assert.notEqual(base, tip, 'the mainline must be ahead for any of this to mean anything');
});

test('the merged commit is reported, with the pull request number it came from', async () => {
  const api = await fetchMainline();
  const tip = (await api.mainlineTip('main')) as string;
  const base = (await api.mergeBase(tip)) as string;

  const commits = await api.commitsIn(base, tip, FILE);

  assert.equal(commits.length, 1, 'exactly one thing landed on this file');
  assert.equal(commits[0].subject, 'Make line 10 configurable (#412)');
  assert.equal(commits[0].author, 'GitRay Test');
  assert.equal(
    commits[0].prNumber,
    412,
    'a squash merge keeps its number in the subject, so the change stays linkable'
  );
});

test('a clean checkout reports no drift collisions at all', async () => {
  // The signal is worthless if it fires on a tree nobody has touched — this is the same
  // trap that made measuring against a pull request's merge base wrong.
  const api = await fetchMainline();
  write(baseLines());

  const verdicts = await predictDrift(api, baseLines());

  assert.ok(verdicts.length > 0, 'the mainline did change this file');
  assert.ok(
    verdicts.every((v) => v.severity === 'ambient'),
    'with no work of your own, merged work cannot collide with it'
  );
});

test('editing the same line the merged commit touched is a collision', async () => {
  const api = await fetchMainline();
  const mine = withLine(CONTESTED, 'const line10 = MINE;');
  write(mine);

  const verdicts = await predictDrift(api, mine);

  assert.ok(
    verdicts.some((v) => v.severity === 'collision'),
    'GitRay should predict a collision with what already merged'
  );
  assert.equal(
    gitSaysRebaseConflicts('collide', mine),
    true,
    'git should also refuse to rebase this cleanly'
  );
});

test('editing far from the merged commit rebases cleanly, and GitRay says so', async () => {
  const api = await fetchMainline();
  const mine = withLine(FAR_AWAY, 'const line2 = MINE;');
  write(mine);

  const verdicts = await predictDrift(api, mine);

  assert.ok(
    verdicts.every((v) => v.severity === 'ambient'),
    'an edit eight lines away is not a conflict'
  );
  assert.equal(
    gitSaysRebaseConflicts('clean', mine),
    false,
    'git should rebase this without stopping'
  );

  write(baseLines());
});

test('drift is still readable from the remote-tracking ref when fetching is off', async () => {
  // With gitray.fetchPullRequestRefs disabled nothing is fetched, so the mainline has to
  // fall back to whatever the user's own git already knows. Without that fallback the
  // feature would simply be absent for anyone who turned fetching off.
  const api = new Git(root);
  git(['update-ref', '-d', mainlineRef('main')]);
  git(['fetch', '-q', 'origin']);

  const tip = await api.mainlineTip('main');

  assert.equal(
    tip,
    git(['rev-parse', 'refs/remotes/origin/main']).trim(),
    'the remote-tracking ref is the fallback when GitRay has no copy of its own'
  );
});

test('mainlineTip is undefined when the branch is unknown locally', async () => {
  const api = new Git(root);
  assert.equal(await api.mainlineTip('no-such-branch'), undefined);
  assert.equal(await api.mainlineTip(''), undefined);
});

test('removing GitRay refs takes the mainline copy with it', async () => {
  const api = await fetchMainline();
  git(['update-ref', prRef(1), 'HEAD']);

  assert.ok(await api.refOid(mainlineRef('main')), 'the mainline ref should exist first');

  const removed = await api.deleteAllRefs();

  assert.ok(removed >= 2, `expected both namespaces to be cleared, removed ${removed}`);
  assert.equal(
    await api.refOid(mainlineRef('main')),
    undefined,
    'the mainline copy must not survive a cleanup that claims to remove everything'
  );
  assert.equal(await api.refOid(prRef(1)), undefined);
});

/**
 * Upstream drift must not be reported as your work.
 *
 * A pull request branches from the mainline, then the mainline moves on. Diffing your
 * working tree against that pull request's *merge base* makes every commit that landed
 * since look like something you did — so a pristine checkout would report collisions with
 * changes nobody working on this machine has made.
 *
 * Those overlaps are real conflicts for the pull request's author to rebase away. They are
 * not yours. GitRay measures your side against where your branch left the mainline, which
 * is what these tests pin down.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Git, prRef } from '../../src/providers/git.js';
import { alignLines, splitLines } from '../../src/model/lineMap.js';

let root: string;
let origin: string;

const FILE = 'app.ts';
const CONTESTED = 10;

function git(args: string[], cwd = root): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
}

function write(content: string[]): void {
  writeFileSync(join(root, FILE), content.join('\n') + '\n', 'utf8');
}

function read(): string {
  return readFileSync(join(root, FILE), 'utf8');
}

function baseLines(): string[] {
  return Array.from({ length: 20 }, (_, i) => `const line${i} = ${i};`);
}

before(() => {
  const workspace = mkdtempSync(join(tmpdir(), 'gitray-drift-'));
  origin = join(workspace, 'origin.git');
  root = join(workspace, 'work');
  mkdirSync(root, { recursive: true });

  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);

  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'GitRay Test']);
  git(['config', 'commit.gpgsign', 'false']);

  // Keep git from warning about line-ending conversion on every fixture write.
  git(['config', 'core.autocrlf', 'false']);
  git(['remote', 'add', 'origin', origin]);

  write(baseLines());
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  git(['push', '-q', 'origin', 'main']);

  // A collaborator opens a pull request off this commit, changing one line.
  git(['checkout', '-q', '-b', 'collab']);
  const theirs = baseLines();
  theirs[CONTESTED] = 'const line10 = THEIRS;';
  write(theirs);
  git(['commit', '-qam', 'collaborator change']);
  git(['update-ref', prRef(1), 'HEAD']);
  git(['checkout', '-q', 'main']);

  // Meanwhile the mainline moves on, touching the very same line.
  const upstream = baseLines();
  upstream[CONTESTED] = 'const line10 = UPSTREAM;';
  write(upstream);
  git(['commit', '-qam', 'upstream change']);
  git(['push', '-q', 'origin', 'main']);
  git(['fetch', '-q', 'origin']);
});

after(() => {
  try {
    rmSync(join(root, '..'), { recursive: true, force: true });
  } catch {
    // Windows may still hold a handle on pack files.
  }
});

test('the pull request merge base is genuinely older than the mainline', () => {
  // Without this the scenario would not reproduce the bug at all.
  const api = new Git(root);
  return api.mergeBase(prRef(1)).then(async (mergeBase) => {
    const mainline = await api.mainlineBase('main', 'origin');
    assert.ok(mergeBase, 'expected a merge base');
    assert.ok(mainline, 'expected a mainline base');
    assert.notEqual(mergeBase, mainline, 'the mainline must have moved past the merge base');
  });
});

test('measuring against the merge base wrongly attributes upstream work to you', async () => {
  // This is the behaviour being guarded against, asserted so the test fails loudly if the
  // scenario ever stops reproducing rather than silently proving nothing.
  const api = new Git(root);
  const mergeBase = await api.mergeBase(prRef(1));
  const baseText = await api.showFile(mergeBase as string, FILE);

  const alignment = alignLines(splitLines(baseText as string), splitLines(read()));
  assert.ok(
    alignment.localEdits.length > 0,
    'against the merge base, an untouched checkout looks edited'
  );
});

test('measuring against the mainline reports no work on a clean checkout', async () => {
  const api = new Git(root);
  const mainline = await api.mainlineBase('main', 'origin');
  assert.ok(mainline);

  const mainlineText = await api.showFile(mainline, FILE);
  const alignment = alignLines(splitLines(mainlineText as string), splitLines(read()));

  assert.deepEqual(alignment.bufferEdits, [], 'a pristine checkout has no work of your own');
});

test('your actual edits are still detected against the mainline', async () => {
  const api = new Git(root);
  const mainline = await api.mainlineBase('main', 'origin');

  const mine = baseLines();
  mine[CONTESTED] = 'const line10 = MINE;';
  write(mine);

  const mainlineText = await api.showFile(mainline as string, FILE);
  const alignment = alignLines(splitLines(mainlineText as string), splitLines(read()));

  assert.equal(alignment.bufferEdits.length, 1, 'your one edit should be the only one');
  assert.deepEqual(alignment.bufferEdits[0], { start: CONTESTED, end: CONTESTED + 1 });

  write(baseLines().map((line, i) => (i === CONTESTED ? 'const line10 = UPSTREAM;' : line)));
});

test('mainlineBase falls back to undefined without a remote-tracking branch', async () => {
  const api = new Git(root);
  assert.equal(await api.mainlineBase('no-such-branch', 'origin'), undefined);
  assert.equal(await api.mainlineBase('', 'origin'), undefined);
});

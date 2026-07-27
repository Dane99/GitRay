/**
 * End-to-end check of the real git pipeline, against real git.
 *
 * The unit tests prove the algorithms are internally consistent. These prove the thing
 * that actually matters: that GitRay's prediction agrees with git. Each scenario builds a
 * throwaway repository, sets up a collaborator branch the way a fetched pull request head
 * would appear, asks GitRay whether the two sides collide — and then performs the real
 * merge to see whether git says the same thing.
 *
 * A disagreement here means the extension is lying to users, so these assertions are the
 * ones to trust.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Git, prRef } from '../../src/providers/git.js';
import { alignLines, splitLines } from '../../src/model/lineMap.js';
import { classifyProximity } from '../../src/model/collision.js';

let root: string;

const FILE = 'src/app.ts';

/** Twenty numbered lines, so edits can be placed at precise, obvious offsets. */
function baseContent(): string {
  return Array.from({ length: 20 }, (_, i) => `const line${i} = ${i};`).join('\n') + '\n';
}

function git(args: string[], cwd = root): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
}

function write(relative: string, content: string): void {
  const full = join(root, ...relative.split('/'));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** Replace a 0-based line range with new lines. */
function edit(content: string, start: number, end: number, replacement: string[]): string {
  const lines = content.split('\n');
  lines.splice(start, end - start, ...replacement);
  return lines.join('\n');
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'gitray-test-'));

  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'GitRay Test']);
  git(['config', 'commit.gpgsign', 'false']);

  // Keep git from warning about line-ending conversion on every fixture write.
  git(['config', 'core.autocrlf', 'false']);

  write(FILE, baseContent());
  git(['add', '.']);
  git(['commit', '-m', 'base']);
});

after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a handle on freshly-written pack files; the temp
    // directory gets cleaned up by the OS either way.
  }
});

/**
 * Create a collaborator branch that edits a line range, parked at refs/gitray/pr/<n>
 * exactly as a fetched pull request head would be, then return to main.
 */
function createCollaboratorBranch(
  prNumber: number,
  start: number,
  end: number,
  replacement: string[]
): void {
  const branch = `collab-${prNumber}`;
  git(['checkout', '-q', '-b', branch, 'main']);
  write(FILE, edit(baseContent(), start, end, replacement));
  git(['commit', '-q', '-am', `collaborator change ${prNumber}`]);
  git(['update-ref', prRef(prNumber), 'HEAD']);
  git(['checkout', '-q', 'main']);
}

/** What GitRay predicts for one collaborator branch against the current working tree. */
async function predict(prNumber: number, workingContent: string) {
  const api = new Git(root);

  const mergeBase = await api.mergeBase(prRef(prNumber));
  assert.ok(mergeBase, 'expected a merge base');

  const diffs = await api.diffRange(mergeBase, prRef(prNumber), [FILE]);
  const baseText = await api.showFile(mergeBase, FILE);
  assert.ok(baseText !== undefined, 'expected the file to exist at the merge base');

  const alignment = alignLines(splitLines(baseText), splitLines(workingContent));

  return diffs
    .flatMap((file) => file.hunks)
    .map((hunk) => classifyProximity(hunk.baseRange, alignment.localEdits, 3));
}

/**
 * Ask git for the truth: does merging the collaborator branch actually conflict?
 *
 * Commits the given content on a scratch branch and attempts a real merge, then puts the
 * repository back exactly as it was so the next scenario starts clean.
 */
function gitSaysConflict(prNumber: number, myContent: string): boolean {
  git(['checkout', '-q', '-B', `verify-${prNumber}`, 'main']);
  write(FILE, myContent);
  git(['commit', '-q', '-am', 'my work']);

  let conflicted = false;
  try {
    git(['merge', '--no-commit', '--no-ff', prRef(prNumber)]);
  } catch {
    conflicted = true;
  }

  try {
    git(['merge', '--abort']);
  } catch {
    // Nothing to abort when the merge succeeded outright.
  }

  git(['checkout', '-q', 'main']);
  git(['reset', '-q', '--hard', 'main']);
  // Restore the uncommitted working state the scenario was exercising.
  write(FILE, myContent);
  return conflicted;
}

test('predicts a collision where git reports a conflict', async () => {
  // They rewrite lines 10-12; I rewrite lines 11-13. The ranges overlap.
  createCollaboratorBranch(1, 10, 13, ['// theirs A', '// theirs B', '// theirs C']);

  const mine = edit(baseContent(), 11, 14, ['// mine A', '// mine B', '// mine C']);
  write(FILE, mine);

  const verdicts = await predict(1, mine);
  assert.ok(
    verdicts.some((v) => v.severity === 'collision'),
    'GitRay should predict a collision'
  );

  assert.equal(gitSaysConflict(1, mine), true, 'git should also report a conflict');
});

test('predicts no collision where git merges cleanly', async () => {
  // They edit near the top, I edit near the bottom. Nowhere close.
  createCollaboratorBranch(2, 1, 3, ['// theirs top', '// theirs top 2']);

  const mine = edit(baseContent(), 16, 18, ['// mine bottom', '// mine bottom 2']);
  write(FILE, mine);

  const verdicts = await predict(2, mine);
  assert.ok(
    verdicts.every((v) => v.severity === 'ambient'),
    'GitRay should report only ambient activity'
  );

  assert.equal(gitSaysConflict(2, mine), false, 'git should merge cleanly');
});

test('treats exactly adjacent edits the way git does', async () => {
  // They replace lines 5-7, I replace lines 7-9. The ranges touch but do not overlap:
  // this is the boundary case the whole severity model turns on.
  createCollaboratorBranch(3, 5, 8, ['// theirs X', '// theirs Y', '// theirs Z']);

  const mine = edit(baseContent(), 8, 11, ['// mine X', '// mine Y', '// mine Z']);
  write(FILE, mine);

  const verdicts = await predict(3, mine);
  const worst = verdicts.some((v) => v.severity === 'collision')
    ? 'collision'
    : verdicts.some((v) => v.severity === 'nearMiss')
      ? 'nearMiss'
      : 'ambient';

  const conflicts = gitSaysConflict(3, mine);

  // Whatever git decides, GitRay must not be the more optimistic of the two.
  if (conflicts) {
    assert.equal(worst, 'collision', 'git conflicted, so GitRay must say collision');
  } else {
    assert.notEqual(worst, 'ambient', 'git merged, but the edits are close enough to flag');
  }
});

test('reads a pure addition as an insertion point, not a changed line', async () => {
  createCollaboratorBranch(4, 10, 10, ['// inserted by them']);

  const untouched = baseContent();
  write(FILE, untouched);

  const api = new Git(root);
  const mergeBase = await api.mergeBase(prRef(4));
  assert.ok(mergeBase);

  const diffs = await api.diffRange(mergeBase, prRef(4), [FILE]);
  const hunks = diffs.flatMap((file) => file.hunks);

  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].kind, 'add');
  assert.equal(
    hunks[0].baseRange.start,
    hunks[0].baseRange.end,
    'an addition occupies no base lines'
  );
  assert.deepEqual(hunks[0].added, ['// inserted by them']);
});

test('maps a collaborator range through edits made above it', async () => {
  createCollaboratorBranch(5, 15, 17, ['// theirs late', '// theirs late 2']);

  // Insert three lines at the very top, pushing everything below down by three.
  const mine = edit(baseContent(), 0, 0, ['// mine 1', '// mine 2', '// mine 3']);
  write(FILE, mine);

  const api = new Git(root);
  const mergeBase = await api.mergeBase(prRef(5));
  assert.ok(mergeBase);

  const baseText = await api.showFile(mergeBase, FILE);
  assert.ok(baseText !== undefined);

  const diffs = await api.diffRange(mergeBase, prRef(5), [FILE]);
  const hunk = diffs.flatMap((file) => file.hunks)[0];
  const alignment = alignLines(splitLines(baseText), splitLines(mine));

  const mapped = alignment.toBufferRange(hunk.baseRange);
  assert.equal(mapped.start, hunk.baseRange.start + 3, 'indicator shifts down by three lines');

  const verdict = classifyProximity(hunk.baseRange, alignment.localEdits, 3);
  assert.equal(verdict.severity, 'ambient', 'an edit far above is not a conflict');
});

test('detects the file GitRay should scan as changed since the merge base', async () => {
  const mine = edit(baseContent(), 2, 3, ['// mine']);
  write(FILE, mine);

  const api = new Git(root);
  const mergeBase = await api.mergeBase(prRef(1));
  assert.ok(mergeBase);

  const changed = await api.changedSince(mergeBase);
  assert.ok(changed.includes(FILE), 'uncommitted work must appear in the scan candidates');
});

test('a present object with a missing ref still counts as needing a fetch', async () => {
  // The trap: removing refs leaves the objects reachable-ish in the database, so asking
  // "do we have this commit?" answers yes while every ref-based operation fails. Deciding
  // to fetch on object existence would leave line-level indicators permanently broken
  // after a ref cleanup or a force push.
  const api = new Git(root);

  const headOid = git(['rev-parse', prRef(1)]).trim();
  assert.equal(await api.refOid(prRef(1)), headOid, 'ref should resolve before removal');

  git(['update-ref', '-d', prRef(1)]);

  // The commit object is still in the database...
  const objectStillPresent = (() => {
    try {
      git(['cat-file', '-e', `${headOid}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  })();
  assert.equal(objectStillPresent, true, 'the object should outlive the ref');

  // ...but the ref no longer resolves, which is what the fetch decision must key on.
  assert.equal(await api.refOid(prRef(1)), undefined);
  assert.equal(await api.mergeBase(prRef(1)), undefined, 'ref-based work fails without the ref');

  git(['update-ref', prRef(1), headOid]);
  assert.equal(await api.refOid(prRef(1)), headOid, 'restored for later tests');
});

test('refOid reports a stale ref rather than pretending it is current', async () => {
  const api = new Git(root);
  const stale = git(['rev-parse', 'main']).trim();
  const real = await api.refOid(prRef(2));

  git(['update-ref', prRef(2), stale]);
  const observed = await api.refOid(prRef(2));

  assert.equal(observed, stale);
  assert.notEqual(observed, real, 'a force-pushed head must not look up to date');

  git(['update-ref', prRef(2), real as string]);
});

test('reports refs it is tracking and removes them on request', async () => {
  const api = new Git(root);

  const tracked = await api.trackedPullRequests();
  assert.ok(tracked.length >= 5, `expected the collaborator refs, got ${tracked.join(', ')}`);

  const removed = await api.deleteAllRefs();
  assert.equal(removed, tracked.length);
  assert.deepEqual(await api.trackedPullRequests(), [], 'removal must leave nothing behind');
});

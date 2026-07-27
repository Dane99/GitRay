import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, hunkHeaderToBaseRange } from '../../src/model/diffParse.js';

test('hunk header maps 1-based counts to 0-based half-open ranges', () => {
  assert.deepEqual(hunkHeaderToBaseRange(1, 3), { start: 0, end: 3 });
  assert.deepEqual(hunkHeaderToBaseRange(12, 1), { start: 11, end: 12 });
});

test('a zero-count hunk header is an insertion point, not a line', () => {
  // "@@ -10,0" means "inserted after base line 10", which as a 0-based insertion point
  // is exactly index 10. Applying the usual -1 shift here would be off by one.
  assert.deepEqual(hunkHeaderToBaseRange(10, 0), { start: 10, end: 10 });
  assert.deepEqual(hunkHeaderToBaseRange(0, 0), { start: 0, end: 0 });
});

test('omitted count defaults to 1', () => {
  const files = parseUnifiedDiff(
    [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -5 +5 @@',
      '-old',
      '+new'
    ].join('\n')
  );
  assert.deepEqual(files[0].hunks[0].baseRange, { start: 4, end: 5 });
});

test('parses a multi-hunk file and classifies each hunk', () => {
  const diff = [
    'diff --git a/src/auth.ts b/src/auth.ts',
    'index 1111111..2222222 100644',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -12,2 +12,3 @@',
    '-  if (!user) return;',
    '-  return user;',
    '+  if (!user?.id) {',
    '+    throw new AuthError();',
    '+  }',
    '@@ -40,0 +41,2 @@',
    '+export const guard = true;',
    '+',
    '@@ -80,3 +82,0 @@',
    '-function dead() {}',
    '-',
    '-const unused = 1;'
  ].join('\n');

  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/auth.ts');

  const [modify, add, remove] = files[0].hunks;

  assert.equal(modify.kind, 'modify');
  assert.deepEqual(modify.baseRange, { start: 11, end: 13 });
  assert.equal(modify.removed.length, 2);
  assert.equal(modify.added.length, 3);

  assert.equal(add.kind, 'add');
  assert.deepEqual(add.baseRange, { start: 40, end: 40 }, 'addition stays an empty range');
  assert.equal(add.added.length, 2);

  assert.equal(remove.kind, 'delete');
  assert.deepEqual(remove.baseRange, { start: 79, end: 82 });
  assert.equal(remove.added.length, 0);
});

test('parses several files in one diff', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1 +1 @@',
    '-a',
    '+A',
    'diff --git a/b.ts b/b.ts',
    '--- a/b.ts',
    '+++ b/b.ts',
    '@@ -2 +2 @@',
    '-b',
    '+B'
  ].join('\n');

  const files = parseUnifiedDiff(diff);
  assert.deepEqual(files.map((f) => f.path), ['a.ts', 'b.ts']);
  assert.equal(files[1].hunks[0].baseRange.start, 1);
});

test('flags new and deleted files', () => {
  const created = parseUnifiedDiff(
    [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two'
    ].join('\n')
  );
  assert.equal(created[0].isNew, true);
  assert.equal(created[0].path, 'new.ts');
  assert.deepEqual(created[0].hunks[0].baseRange, { start: 0, end: 0 });

  const removed = parseUnifiedDiff(
    [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two'
    ].join('\n')
  );
  assert.equal(removed[0].isDeleted, true);
  assert.equal(removed[0].path, 'gone.ts');
});

test('records binary files without hunks', () => {
  const files = parseUnifiedDiff(
    [
      'diff --git a/logo.png b/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ'
    ].join('\n')
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].isBinary, true);
  assert.equal(files[0].path, 'logo.png');
});

test('follows renames', () => {
  const files = parseUnifiedDiff(
    [
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 92%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -3 +3 @@',
      '-x',
      '+y'
    ].join('\n')
  );
  assert.equal(files[0].path, 'new/name.ts');
  assert.equal(files[0].oldPath, 'old/name.ts');
});

test('handles paths containing spaces', () => {
  const files = parseUnifiedDiff(
    [
      'diff --git a/my docs/read me.md b/my docs/read me.md',
      '--- a/my docs/read me.md',
      '+++ b/my docs/read me.md',
      '@@ -1 +1 @@',
      '-a',
      '+b'
    ].join('\n')
  );
  assert.equal(files[0].path, 'my docs/read me.md');
});

test('ignores the no-newline marker rather than counting it as content', () => {
  const files = parseUnifiedDiff(
    [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '\\ No newline at end of file',
      '+b',
      '\\ No newline at end of file'
    ].join('\n')
  );
  assert.deepEqual(files[0].hunks[0].removed, ['a']);
  assert.deepEqual(files[0].hunks[0].added, ['b']);
});

test('empty input yields no files', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
});

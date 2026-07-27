import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesGlob, matchesAny } from '../../src/core/glob.js';

test('a single star does not cross directory boundaries', () => {
  assert.equal(matchesGlob('src/a.ts', 'src/*.ts'), true);
  assert.equal(matchesGlob('src/deep/a.ts', 'src/*.ts'), false);
});

test('a leading **/ matches at any depth including the top level', () => {
  // The top-level case is the one that is easy to get wrong: `**/x` should match a bare
  // `x`, otherwise the default ignore list misses a lockfile at the repository root.
  assert.equal(matchesGlob('package-lock.json', '**/package-lock.json'), true);
  assert.equal(matchesGlob('web/package-lock.json', '**/package-lock.json'), true);
  assert.equal(matchesGlob('a/b/c/package-lock.json', '**/package-lock.json'), true);
  assert.equal(matchesGlob('package-lock.json.bak', '**/package-lock.json'), false);
});

test('a trailing /** matches everything underneath', () => {
  assert.equal(matchesGlob('dist/app.js', '**/dist/**'), true);
  assert.equal(matchesGlob('packages/web/dist/a/b.js', '**/dist/**'), true);
  assert.equal(matchesGlob('src/app.js', '**/dist/**'), false);
});

test('extension patterns match at any depth', () => {
  assert.equal(matchesGlob('vendor/jquery.min.js', '**/*.min.js'), true);
  assert.equal(matchesGlob('jquery.min.js', '**/*.min.js'), true);
  assert.equal(matchesGlob('app.js', '**/*.min.js'), false);
});

test('question mark matches exactly one non-separator character', () => {
  assert.equal(matchesGlob('a1.ts', 'a?.ts'), true);
  assert.equal(matchesGlob('a12.ts', 'a?.ts'), false);
  assert.equal(matchesGlob('a/1.ts', 'a?1.ts'), false);
});

test('brace alternation works', () => {
  assert.equal(matchesGlob('a.ts', '*.{ts,js}'), true);
  assert.equal(matchesGlob('a.js', '*.{ts,js}'), true);
  assert.equal(matchesGlob('a.css', '*.{ts,js}'), false);
});

test('dots are literal, not wildcards', () => {
  assert.equal(matchesGlob('axts', '*.ts'), false);
});

test('matchesAny reports whether any pattern hits', () => {
  const globs = ['**/dist/**', '**/*.lock'];
  assert.equal(matchesAny('dist/x.js', globs), true);
  assert.equal(matchesAny('deps/Cargo.lock', globs), true);
  assert.equal(matchesAny('src/main.ts', globs), false);
  assert.equal(matchesAny('src/main.ts', []), false);
});

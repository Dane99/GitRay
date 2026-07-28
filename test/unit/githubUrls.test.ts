/**
 * Deep links into GitHub's diff pages.
 *
 * The anchor is the whole feature and it is unverifiable at runtime: GitHub silently
 * ignores a fragment it does not recognise, so a wrong hash degrades into "landed at the
 * top of the Files tab" — exactly what the link did before, and therefore invisible to
 * anyone testing by clicking. Hence a pinned known-good value rather than a round trip
 * through our own implementation, which would agree with itself no matter what it computed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileDiffAnchor, pullRequestFileUrl } from '../../src/providers/githubUrls.js';

test('the anchor matches what GitHub actually puts on the page', () => {
  // GitHub's own documented example: `src/index.js` on a diff page.
  assert.equal(
    fileDiffAnchor('src/index.js'),
    'diff-bfe9874d239014961b1ae4e89875a6155667db834a410aaaa2ebe3cf89820556'
  );
});

test('the whole path is hashed, not the file name', () => {
  // Two files called index.js in different directories are different anchors, or every
  // link into a repository with more than one of them lands on the wrong one.
  assert.notEqual(fileDiffAnchor('src/index.js'), fileDiffAnchor('test/index.js'));
  assert.notEqual(fileDiffAnchor('src/index.js'), fileDiffAnchor('index.js'));
});

test('builds the Files tab URL a pull request link should reach', () => {
  assert.equal(
    pullRequestFileUrl('https://github.com/Dane99/GitRay/pull/12', 'src/index.js'),
    'https://github.com/Dane99/GitRay/pull/12/files#diff-bfe9874d239014961b1ae4e89875a6155667db834a410aaaa2ebe3cf89820556'
  );
});

test('works on Enterprise hosts, which are just a different origin', () => {
  assert.match(
    pullRequestFileUrl('https://github.acme-corp.example/platform/api/pull/3', 'README.md'),
    /^https:\/\/github\.acme-corp\.example\/platform\/api\/pull\/3\/files#diff-[0-9a-f]{64}$/
  );
});

test('does not double up on a url that already carries a trailing slash, fragment, or /files', () => {
  const expected = pullRequestFileUrl('https://github.com/a/b/pull/1', 'x.ts');

  for (const url of [
    'https://github.com/a/b/pull/1/',
    'https://github.com/a/b/pull/1#issuecomment-99',
    'https://github.com/a/b/pull/1/files',
    'https://github.com/a/b/pull/1/files#diff-something-stale'
  ]) {
    assert.equal(pullRequestFileUrl(url, 'x.ts'), expected, url);
  }
});

test('a path with URL metacharacters needs no escaping, because only its hash is used', () => {
  const url = pullRequestFileUrl('https://github.com/a/b/pull/1', 'src/a b/c#d?e.ts');
  assert.match(url, /^https:\/\/github\.com\/a\/b\/pull\/1\/files#diff-[0-9a-f]{64}$/);
});

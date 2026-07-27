/**
 * Remote URL parsing.
 *
 * This is what decides which repository the editor's GitHub session gets pointed at, so
 * every wrong answer here is either a silent "GitRay does not work in this clone" or, worse,
 * polling somebody else's repository. The scp-like shorthand is the case that breaks first:
 * it is not a URL, `new URL()` accepts it and produces nonsense, and it is what the GitHub
 * clone button hands out for SSH.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteUrl, isGitHubDotCom } from '../../src/providers/remote.js';

test('parses the forms git actually hands out', () => {
  const expected = { host: 'github.com', owner: 'Dane99', name: 'GitRay' };

  for (const url of [
    'https://github.com/Dane99/GitRay.git',
    'https://github.com/Dane99/GitRay',
    'git@github.com:Dane99/GitRay.git',
    'ssh://git@github.com/Dane99/GitRay.git',
    'git://github.com/Dane99/GitRay.git',
    'https://github.com/Dane99/GitRay/'
  ]) {
    const remote = parseRemoteUrl(url);
    assert.ok(remote, `failed to parse ${url}`);
    assert.equal(remote.host, expected.host, url);
    assert.equal(remote.owner, expected.owner, url);
    assert.equal(remote.name, expected.name, url);
    assert.equal(remote.nameWithOwner, 'Dane99/GitRay', url);
  }
});

test('strips credentials, ports, and www from the host', () => {
  // A token embedded in the remote must never survive into anything that gets logged.
  assert.equal(parseRemoteUrl('https://x-access-token:ghp_secret@github.com/a/b')?.host, 'github.com');
  assert.equal(parseRemoteUrl('ssh://git@github.com:22/a/b')?.host, 'github.com');
  assert.equal(parseRemoteUrl('https://www.github.com/a/b')?.host, 'github.com');
});

test('treats the SSH-over-443 host as github.com', () => {
  // Same repositories, different door — and the door is invisible to the API.
  const remote = parseRemoteUrl('ssh://git@ssh.github.com:443/Dane99/GitRay.git');
  assert.equal(remote?.host, 'github.com');
  assert.equal(remote?.nameWithOwner, 'Dane99/GitRay');
});

test('keeps Enterprise hosts distinct from github.com', () => {
  const remote = parseRemoteUrl('git@github.acme-corp.example:platform/api.git');
  assert.ok(remote);
  assert.equal(remote.host, 'github.acme-corp.example');
  assert.equal(remote.nameWithOwner, 'platform/api');
  assert.equal(isGitHubDotCom(remote), false, 'an Enterprise host must not be treated as github.com');
});

test('takes the last two path segments, so a hosted path prefix still resolves', () => {
  assert.equal(parseRemoteUrl('https://ghe.example/github/team/repo.git')?.nameWithOwner, 'team/repo');
});

test('rejects anything that does not name a repository', () => {
  for (const url of [
    '',
    '   ',
    '/srv/mirrors/repo.git',
    'https://github.com/Dane99',
    'https://github.com/',
    'file:///c/repos/local.git',
    'https://github.com/Dane99/Git Ray'
  ]) {
    assert.equal(parseRemoteUrl(url), undefined, `${url} should not parse`);
  }
});

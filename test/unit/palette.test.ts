import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignHues, hashLogin, hueColorId, HUE_COUNT } from '../../src/model/palette.js';

test('a login always hashes to the same value', () => {
  assert.equal(hashLogin('octocat'), hashLogin('octocat'));
  assert.equal(hashLogin('OctoCat'), hashLogin('octocat'), 'case insensitive');
  assert.notEqual(hashLogin('octocat'), hashLogin('octodog'));
});

test('hue ids are 1-based and stay in range', () => {
  assert.equal(hueColorId(0), 'gitray.collaborator1');
  assert.equal(hueColorId(7), 'gitray.collaborator8');
  assert.equal(hueColorId(8), 'gitray.collaborator1');
});

test('active authors all get distinct hues', () => {
  const logins = ['ada', 'grace', 'alan', 'edsger', 'barbara'];
  const hues = assignHues(logins);

  assert.equal(hues.size, logins.length);
  assert.equal(new Set(hues.values()).size, logins.length, 'no two share a hue');
  for (const slot of hues.values()) {
    assert.ok(slot >= 0 && slot < HUE_COUNT);
  }
});

test('assignment does not depend on input order', () => {
  const logins = ['ada', 'grace', 'alan', 'edsger'];
  const forward = assignHues(logins);
  const reversed = assignHues([...logins].reverse());

  for (const login of logins) {
    assert.equal(forward.get(login), reversed.get(login), `${login} moved`);
  }
});

test('duplicate logins collapse to one entry', () => {
  const hues = assignHues(['ada', 'ada', 'grace']);
  assert.equal(hues.size, 2);
});

test('more authors than hues still assigns everyone', () => {
  const logins = Array.from({ length: HUE_COUNT + 5 }, (_, i) => `dev${i}`);
  const hues = assignHues(logins);

  assert.equal(hues.size, logins.length);
  for (const slot of hues.values()) {
    assert.ok(slot >= 0 && slot < HUE_COUNT);
  }
});

test('an author keeps their hue when unrelated people join', () => {
  // Stability is the point: you learn "teal is Priya" and that should survive a
  // teammate opening a pull request, as long as nobody actually wants that hue.
  const before = assignHues(['ada']);
  const after = assignHues(['ada', 'zzzz-unlikely-clash']);
  if (after.get('zzzz-unlikely-clash') !== before.get('ada')) {
    assert.equal(after.get('ada'), before.get('ada'));
  }
});

test('an empty roster yields an empty map', () => {
  assert.equal(assignHues([]).size, 0);
});

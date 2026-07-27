/**
 * The small shared decisions about mainline state.
 *
 * Both of these are the kind of thing that goes wrong quietly. A capped commit count
 * rendered as though it were exact is a number the user has no way to know is a floor, and
 * a tie-break that sorts pull request numbers as strings puts #10 above #9 without ever
 * failing anything. Neither would surface in an integration test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  behindMainline,
  compareOrigins,
  MAX_LOGGED_COMMITS,
  type ChangeOrigin,
  type MainlineCommit,
  type MainlineState
} from '../../src/core/types.js';

function commits(count: number): MainlineCommit[] {
  return Array.from({ length: count }, (_, i) => ({
    sha: `sha${i}`,
    author: 'someone',
    subject: `commit ${i}`,
    date: new Date().toISOString()
  }));
}

function state(count: number, tip = 'tip', base = 'base'): MainlineState {
  return { branch: 'main', tip, base, commits: commits(count) };
}

const pr = (prNumber: number): ChangeOrigin => ({ kind: 'pullRequest', prNumber });
const mainline = (branch = 'main'): ChangeOrigin => ({ kind: 'mainline', branch, commits: [] });

// --- behindMainline ---------------------------------------------------------------------

test('an ordinary count is reported exactly', () => {
  const behind = behindMainline(state(12));

  assert.equal(behind.count, 12);
  assert.equal(behind.capped, false);
  assert.equal(behind.display, '12');
});

test('a count that hits the log cap is shown as a floor, not as an exact number', () => {
  // The log is truncated, so the real answer is "at least this many". Rendering it as a
  // bare number tells the user something the data does not support.
  const behind = behindMainline(state(MAX_LOGGED_COMMITS));

  assert.equal(behind.capped, true);
  assert.equal(behind.display, `${MAX_LOGGED_COMMITS}+`);
});

test('a mainline that has not moved is zero, whatever the commit list says', () => {
  // tip === base means your branch is level with the mainline. Any commits still hanging
  // around in the state are stale and must not be reported as drift.
  const behind = behindMainline(state(5, 'same', 'same'));

  assert.equal(behind.count, 0);
  assert.equal(behind.display, '0');
});

test('no mainline state at all reads as zero rather than throwing', () => {
  const behind = behindMainline(undefined);

  assert.equal(behind.count, 0);
  assert.equal(behind.capped, false);
});

// --- compareOrigins ---------------------------------------------------------------------

test('pull requests order numerically, not as strings', () => {
  // The regression this guards: comparing origin keys as text sorts "pr:10" before "pr:9".
  assert.ok(compareOrigins(pr(9), pr(10)) < 0, '#9 should come before #10');
  assert.ok(compareOrigins(pr(10), pr(9)) > 0);
  assert.equal(compareOrigins(pr(7), pr(7)), 0);

  const sorted = [pr(10), pr(9), pr(100), pr(1)].sort(compareOrigins);
  assert.deepEqual(
    sorted.map((origin) => (origin.kind === 'pullRequest' ? origin.prNumber : 0)),
    [1, 9, 10, 100]
  );
});

test('the mainline leads, matching how every surface ranks it', () => {
  // What has already landed outranks what might, and the sort has to agree with the
  // annotation's choice of which region to name first.
  assert.ok(compareOrigins(mainline(), pr(1)) < 0);
  assert.ok(compareOrigins(pr(1), mainline()) > 0);
});

test('two mainlines order by branch, so the sort stays total', () => {
  assert.ok(compareOrigins(mainline('develop'), mainline('main')) < 0);
  assert.equal(compareOrigins(mainline('main'), mainline('main')), 0);
});

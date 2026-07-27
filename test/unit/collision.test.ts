import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProximity, gap, overlaps, maxSeverity } from '../../src/model/collision.js';

test('overlap is detected symmetrically', () => {
  assert.equal(overlaps({ start: 10, end: 20 }, { start: 15, end: 25 }), true);
  assert.equal(overlaps({ start: 15, end: 25 }, { start: 10, end: 20 }), true);
  assert.equal(overlaps({ start: 10, end: 20 }, { start: 20, end: 30 }), false);
});

test('gap counts the lines between two ranges', () => {
  assert.equal(gap({ start: 0, end: 5 }, { start: 8, end: 10 }), 3);
  assert.equal(gap({ start: 8, end: 10 }, { start: 0, end: 5 }), 3);
  assert.equal(gap({ start: 0, end: 5 }, { start: 5, end: 9 }), 0);
  assert.equal(gap({ start: 0, end: 10 }, { start: 3, end: 4 }), 0);
});

test('overlapping edits are a collision', () => {
  const result = classifyProximity({ start: 10, end: 20 }, [{ start: 15, end: 25 }], 3);
  assert.equal(result.severity, 'collision');
  assert.equal(result.distance, 0);
  assert.deepEqual(result.nearest, { start: 15, end: 25 });
});

test('exactly adjacent edits are a collision, not a near miss', () => {
  // This is the case worth being strict about. git will not silently interleave two
  // edits that meet at a seam — it stops and asks — so a zero-line gap must escalate.
  const touching = classifyProximity({ start: 10, end: 20 }, [{ start: 20, end: 30 }], 3);
  assert.equal(touching.severity, 'collision');
  assert.equal(touching.distance, 0);

  const touchingBefore = classifyProximity({ start: 20, end: 30 }, [{ start: 10, end: 20 }], 3);
  assert.equal(touchingBefore.severity, 'collision');
});

test('near misses are reported up to the proximity window and no further', () => {
  const inside = classifyProximity({ start: 0, end: 5 }, [{ start: 8, end: 9 }], 3);
  assert.equal(inside.severity, 'nearMiss');
  assert.equal(inside.distance, 3);

  const outside = classifyProximity({ start: 0, end: 5 }, [{ start: 9, end: 10 }], 3);
  assert.equal(outside.severity, 'ambient');
  assert.equal(outside.distance, 4);
});

test('a proximity window of zero disables near misses but keeps collisions', () => {
  assert.equal(classifyProximity({ start: 0, end: 5 }, [{ start: 6, end: 7 }], 0).severity, 'ambient');
  assert.equal(classifyProximity({ start: 0, end: 5 }, [{ start: 5, end: 7 }], 0).severity, 'collision');
});

test('with no local edits everything is ambient', () => {
  const result = classifyProximity({ start: 10, end: 20 }, [], 3);
  assert.equal(result.severity, 'ambient');
  assert.equal(result.nearest, undefined);
});

test('the worst nearby edit wins', () => {
  const result = classifyProximity(
    { start: 10, end: 12 },
    [
      { start: 100, end: 101 },
      { start: 11, end: 13 },
      { start: 50, end: 51 }
    ],
    3
  );
  assert.equal(result.severity, 'collision');
  assert.deepEqual(result.nearest, { start: 11, end: 13 });
});

test('an insertion inside your edited region collides', () => {
  const result = classifyProximity({ start: 12, end: 12 }, [{ start: 10, end: 15 }], 3);
  assert.equal(result.severity, 'collision');
});

test('two insertions claiming the same seam collide', () => {
  // Both sides add lines at the same point; git cannot decide an order for them.
  const result = classifyProximity({ start: 12, end: 12 }, [{ start: 12, end: 12 }], 3);
  assert.equal(result.severity, 'collision');
  assert.equal(result.distance, 0);
});

test('an insertion a few lines from your edit is only a near miss', () => {
  const result = classifyProximity({ start: 20, end: 20 }, [{ start: 10, end: 18 }], 3);
  assert.equal(result.severity, 'nearMiss');
  assert.equal(result.distance, 2);
});

test('severity ranking picks the strongest signal', () => {
  assert.equal(maxSeverity(['ambient', 'nearMiss', 'ambient']), 'nearMiss');
  assert.equal(maxSeverity(['nearMiss', 'collision']), 'collision');
  assert.equal(maxSeverity([]), 'ambient');
});

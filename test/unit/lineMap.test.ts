import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignLines, splitLines } from '../../src/model/lineMap.js';

const base = splitLines(
  ['line0', 'line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7'].join('\n')
);

test('an unmodified buffer maps identically and reports no local edits', () => {
  const map = alignLines(base, [...base]);
  assert.equal(map.clean, true);
  assert.deepEqual(map.localEdits, []);
  for (let i = 0; i < base.length; i++) {
    assert.equal(map.toBuffer(i), i);
  }
});

test('inserting above a region shifts it down by exactly that many lines', () => {
  const buffer = ['new-a', 'new-b', ...base];
  const map = alignLines(base, buffer);

  assert.deepEqual(map.toBufferRange({ start: 4, end: 6 }), { start: 6, end: 8 });
  assert.deepEqual(map.localEdits, [{ start: 0, end: 0 }]);
});

test('deleting above a region shifts it up', () => {
  const buffer = base.slice(2);
  const map = alignLines(base, buffer);

  assert.deepEqual(map.toBufferRange({ start: 4, end: 6 }), { start: 2, end: 4 });
  assert.deepEqual(map.localEdits, [{ start: 0, end: 2 }]);
});

test('editing below a region leaves it alone', () => {
  const buffer = [...base.slice(0, 6), 'changed', 'changed'];
  const map = alignLines(base, buffer);

  assert.deepEqual(map.toBufferRange({ start: 1, end: 3 }), { start: 1, end: 3 });
});

test('a base range you replaced maps onto its replacement', () => {
  // Base lines 3..5 became a single line.
  const buffer = [...base.slice(0, 3), 'merged', ...base.slice(5)];
  const map = alignLines(base, buffer);

  const mapped = map.toBufferRange({ start: 3, end: 5 });
  assert.deepEqual(mapped, { start: 3, end: 4 });
  assert.deepEqual(map.localEdits, [{ start: 3, end: 5 }]);
});

test('an insertion point stays a point instead of widening', () => {
  const buffer = [...base];
  const map = alignLines(base, buffer);

  // A collaborator adding lines at base seam 4 must not claim line 4 as "changed".
  assert.deepEqual(map.toBufferRange({ start: 4, end: 4 }), { start: 4, end: 4 });
});

test('an insertion point inside a region you deleted collapses to one position', () => {
  const buffer = [...base.slice(0, 2), ...base.slice(6)];
  const map = alignLines(base, buffer);

  const mapped = map.toBufferRange({ start: 4, end: 4 });
  assert.equal(mapped.start, mapped.end, 'still a point');
  assert.equal(mapped.start, 2, 'lands where the deleted run used to begin');
});

test('a collaborator range past the end of your file clamps into the buffer', () => {
  const buffer = base.slice(0, 3);
  const map = alignLines(base, buffer);

  const mapped = map.toBufferRange({ start: 6, end: 8 });
  assert.ok(mapped.start <= buffer.length);
  assert.ok(mapped.end <= buffer.length);
  assert.ok(mapped.end >= mapped.start);
});

test('several separate edits are reported separately', () => {
  const buffer = ['x', ...base.slice(0, 3), 'y', ...base.slice(4)];
  const map = alignLines(base, buffer);

  assert.equal(map.localEdits.length, 2);
  assert.deepEqual(map.localEdits[0], { start: 0, end: 0 });
  assert.deepEqual(map.localEdits[1], { start: 3, end: 4 });
});

test('a modification is one edit, not a delete plus an add', () => {
  // jsdiff emits removed-then-added for a replacement; coalescing them matters because
  // two adjacent edits would report a wider damaged range than the user actually made.
  const buffer = [...base.slice(0, 2), 'replaced', ...base.slice(3)];
  const map = alignLines(base, buffer);

  assert.equal(map.localEdits.length, 1);
  assert.deepEqual(map.localEdits[0], { start: 2, end: 3 });
});

test('mapping is monotonic across the whole file', () => {
  const buffer = ['top', ...base.slice(0, 2), 'mid', ...base.slice(4, 7)];
  const map = alignLines(base, buffer);

  let previous = -1;
  for (let i = 0; i <= base.length; i++) {
    const mapped = map.toBuffer(i);
    assert.ok(mapped >= previous, `line ${i} mapped backwards`);
    previous = mapped;
  }
});

test('buffer ranges map back into base coordinates', () => {
  const buffer = ['new-a', 'new-b', ...base];
  const map = alignLines(base, buffer);

  // Buffer lines 6-7 are base lines 4-5, shifted by the two inserted lines.
  assert.deepEqual(map.toBaseRange({ start: 6, end: 8 }), { start: 4, end: 6 });
});

test('base and buffer mapping round-trip for unchanged regions', () => {
  const buffer = [...base.slice(0, 2), 'mine', ...base.slice(3)];
  const map = alignLines(base, buffer);

  for (const range of [
    { start: 4, end: 6 },
    { start: 0, end: 1 },
    { start: 6, end: 8 }
  ]) {
    const there = map.toBufferRange(range);
    assert.deepEqual(map.toBaseRange(there), range, `round trip failed for ${JSON.stringify(range)}`);
  }
});

test('bufferEdits reports your changes in buffer coordinates', () => {
  const buffer = ['x', ...base.slice(0, 3), 'y', ...base.slice(4)];
  const map = alignLines(base, buffer);

  assert.equal(map.bufferEdits.length, map.localEdits.length);
  assert.deepEqual(map.bufferEdits[0], { start: 0, end: 1 });
  // The second edit sits one line later in the buffer than in the base.
  assert.deepEqual(map.bufferEdits[1], { start: 4, end: 5 });
});

test('an identical buffer reports no edits on either side', () => {
  const map = alignLines(base, [...base]);
  assert.deepEqual(map.bufferEdits, []);
  assert.deepEqual(map.localEdits, []);
});

test('a CRLF working tree aligns with an LF blob', () => {
  // On Windows with core.autocrlf=true — the default for most clones there — git stores
  // LF and checks out CRLF. Comparing the two without normalising makes every single line
  // look modified, which would collapse the whole file into one giant "change" and put
  // indicators nowhere near the truth.
  const blob = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const workingTree = 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n';

  const map = alignLines(splitLines(blob), splitLines(workingTree));

  assert.equal(map.clean, true, 'line endings alone are not an edit');
  assert.deepEqual(map.localEdits, []);
  assert.deepEqual(map.toBufferRange({ start: 1, end: 2 }), { start: 1, end: 2 });
});

test('a real edit in a CRLF file is still found', () => {
  const blob = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const workingTree = 'const a = 1;\r\nconst b = CHANGED;\r\nconst c = 3;\r\n';

  const map = alignLines(splitLines(blob), splitLines(workingTree));

  assert.deepEqual(map.localEdits, [{ start: 1, end: 2 }]);
});

test('splitLines matches how an editor counts a trailing newline', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b', '']);
  assert.deepEqual(splitLines('a\r\nb'), ['a', 'b']);
  assert.deepEqual(splitLines(''), ['']);
});

test('an empty base file maps everything to the start', () => {
  const map = alignLines([''], ['one', 'two']);
  assert.equal(map.toBuffer(0), 0);
});

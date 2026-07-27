/**
 * What the painter actually hands to VS Code.
 *
 * These assertions exist because of a real report: the collision tint and the overview
 * ruler mark showed up, but the hover card never did. The cause was a decoration range of
 * `(line, 0)` to `(line, 0)` — empty. A whole-line background and a ruler mark both paint
 * happily from an empty range, so the bug was invisible in every other respect while the
 * hover, which needs actual text to attach to, silently never fired.
 *
 * So: ranges must cover real text, and the hover must be attached.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { makeVscodeStub, type VscodeStub } from './vscodeStub.js';
import type { FileAnalysis, PullRequest, ResolvedRegion, Severity } from '../../src/core/types.js';

type ModuleLoader = { _load(request: string, parent: unknown, isMain: boolean): unknown };

let stub: VscodeStub;
let DecorationPainter: typeof import('../../src/ui/decorations.js').DecorationPainter;

const LINES = [
  'export function get(name) {',
  '  const lc = name.toLowerCase();',
  '  return this.headers[lc];',
  '}',
  ''
];

before(async () => {
  stub = makeVscodeStub(process.cwd());

  const loader = Module as unknown as ModuleLoader;
  const original = loader._load;
  loader._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub.api;
    return original.call(this, request, parent, isMain);
  };

  ({ DecorationPainter } = await import('../../src/ui/decorations.js'));
});

interface Captured {
  type: { options?: Record<string, unknown> };
  options: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; hoverMessage?: { value: string }; renderOptions?: any }[];
}

function fakeEditor(cursorLine = 0) {
  const captured: Captured[] = [];
  return {
    captured,
    editor: {
      document: {
        uri: { toString: () => 'file:///repo/lib/request.js', scheme: 'file' },
        lineCount: LINES.length,
        languageId: 'javascript',
        lineAt: (line: number) => ({ text: LINES[line] ?? '' })
      },
      selection: { active: { line: cursorLine } },
      setDecorations: (type: unknown, options: unknown) => {
        captured.push({ type, options } as unknown as Captured);
      }
    } as never
  };
}

function region(line: number, severity: Severity): ResolvedRegion {
  return {
    origin: { kind: 'pullRequest', prNumber: 7395 },
    author: 'armanmikoyan',
    baseSha: 'abc1234',
    baseRange: { start: line, end: line + 1 },
    kind: 'modify',
    removed: ['  const lc = name;'],
    added: ['  const lc = name.toLowerCase();'],
    range: { start: line, end: line + 1 },
    severity,
    distance: severity === 'collision' ? 0 : 5
  };
}

/** The same shape, but for something that already merged into the mainline. */
function mergedRegion(line: number, severity: Severity, prNumber?: number): ResolvedRegion {
  return {
    origin: {
      kind: 'mainline',
      branch: 'master',
      commits: [
        {
          sha: 'a1b2c3d',
          author: 'jonchurch',
          subject: prNumber ? `fix(req.get): normalise header keys (#${prNumber})` : 'hotfix header lookup',
          date: new Date().toISOString(),
          prNumber
        }
      ]
    },
    author: 'jonchurch',
    baseSha: 'abc1234',
    baseRange: { start: line, end: line + 1 },
    kind: 'modify',
    removed: ['  const lc = name;'],
    added: ['  const lc = name.toLowerCase();'],
    range: { start: line, end: line + 1 },
    severity,
    distance: severity === 'collision' ? 0 : 2
  };
}

const pullRequests = new Map<number, PullRequest>([
  [
    7395,
    {
      number: 7395,
      title: 'fix(req.get): perform case-insensitive header lookup',
      author: 'armanmikoyan',
      headRefName: 'fix/req-get',
      headRefOid: 'deadbeef',
      baseRefName: 'master',
      isDraft: false,
      updatedAt: new Date().toISOString(),
      url: 'https://github.com/expressjs/express/pull/7395',
      additions: 4,
      deletions: 2,
      files: [{ path: 'lib/request.js', additions: 4, deletions: 2 }]
    }
  ]
]);

const config = {
  refreshInterval: 60,
  includeDrafts: false,
  includeOwnPullRequests: false,
  maxPullRequests: 30,
  proximityLines: 3,
  decorationMode: 'ambient' as const,
  showInlineAnnotations: true,
  fetchPullRequestRefs: true,
  trackMainlineDrift: true,
  mainlineBranch: '',
  mutedPullRequests: [],
  mutedAuthors: [],
  ignoreGlobs: [],
  maxRegionsPerFile: 400
};

function paint(analysis: FileAnalysis, cursorLine = 0) {
  const painter = new DecorationPainter(() => {});
  const { editor, captured } = fakeEditor(cursorLine);
  painter.paint(editor, analysis, pullRequests, () => 0, config);
  painter.dispose();
  return captured.filter((call) => call.options.length > 0);
}

const analysisWith = (...regions: ResolvedRegion[]): FileAnalysis => ({
  path: 'lib/request.js',
  regions,
  degraded: false
});

test('a single-line collision produces a range with text in it', () => {
  const calls = paint(analysisWith(region(1, 'collision')));
  const withRange = calls.find((call) => call.options.some((o) => o.hoverMessage));
  assert.ok(withRange, 'expected a decoration carrying a hover');

  const { range } = withRange.options[0];
  assert.equal(range.start.line, 1);
  assert.equal(range.end.line, 1);
  assert.ok(
    range.end.character > range.start.character,
    `range must cover text, got ${range.start.character}-${range.end.character}`
  );
  assert.equal(range.end.character, LINES[1].length, 'should span the whole line');
});

test('the hover names the pull request, the author, and the conflict', () => {
  const calls = paint(analysisWith(region(1, 'collision')));
  const hover = calls.flatMap((c) => c.options).find((o) => o.hoverMessage)?.hoverMessage?.value;

  assert.ok(hover, 'no hover message was attached');
  assert.match(hover, /#7395/, 'hover should name the pull request');
  assert.match(hover, /armanmikoyan/, 'hover should name the author');
  assert.match(hover, /overlaps your own edit/i, 'hover should explain the collision');
  assert.match(hover, /command:gitray\.openPullRequest/, 'hover should offer an action');
});

test('ambient regions get a hover too, not only collisions', () => {
  const calls = paint(analysisWith(region(2, 'ambient')));
  const hover = calls.flatMap((c) => c.options).find((o) => o.hoverMessage)?.hoverMessage?.value;

  assert.ok(hover, 'ambient changes should still be explainable');
  assert.match(hover, /#7395/);
});

test('a collision emits an inline annotation naming the author and pull request', () => {
  const calls = paint(analysisWith(region(1, 'collision')));
  const annotation = calls
    .flatMap((c) => c.options)
    .map((o) => o.renderOptions?.after?.contentText)
    .find((text): text is string => typeof text === 'string');

  assert.ok(annotation, 'expected an end-of-line annotation');
  assert.match(annotation, /armanmikoyan/);
  assert.match(annotation, /#7395/);
  assert.match(annotation, /⟂/, 'collisions use the perpendicular mark');
});

test('merged work says so, and speaks about the rebase rather than the merge', () => {
  // The tense is the whole distinction. An open pull request *would* conflict and might yet
  // move; something already on the mainline *will* meet you, whatever anyone does next.
  const calls = paint(analysisWith(mergedRegion(1, 'collision')));
  const hover = calls.flatMap((c) => c.options).find((o) => o.hoverMessage)?.hoverMessage?.value;

  assert.ok(hover, 'merged drift should still be explainable');
  assert.match(hover, /has moved under you/, 'the card should name what happened');
  assert.match(hover, /master/, 'and which branch it happened on');
  assert.match(hover, /overlaps your own edit/i);
  assert.match(hover, /next rebase will stop here/i, 'a merge is not what resolves this');
  assert.doesNotMatch(hover, /Merging will need a decision/, 'that is the open-PR wording');
});

test('a merged commit that kept its pull request number stays linkable', () => {
  const calls = paint(analysisWith(mergedRegion(1, 'collision', 412)));
  const hover = calls.flatMap((c) => c.options).find((o) => o.hoverMessage)?.hoverMessage?.value;

  assert.ok(hover);
  assert.match(hover, /command:gitray\.openPullRequest/, 'should offer the original discussion');
  assert.match(hover, /#412/);
});

test('a merged commit with no recoverable number offers no pull request link', () => {
  // Fabricating one would open somebody else's discussion, which is worse than no link.
  const calls = paint(analysisWith(mergedRegion(1, 'collision')));
  const hover = calls.flatMap((c) => c.options).find((o) => o.hoverMessage)?.hoverMessage?.value;

  assert.ok(hover);
  assert.doesNotMatch(hover, /command:gitray\.openPullRequest/);
  assert.match(hover, /command:gitray\.diffWithMainline/, 'comparing is still offered');
});

test('the inline annotation marks merged work as merged, not as a pull request', () => {
  const calls = paint(analysisWith(mergedRegion(1, 'collision')));
  const annotation = calls
    .flatMap((c) => c.options)
    .map((o) => o.renderOptions?.after?.contentText)
    .find((text): text is string => typeof text === 'string');

  assert.ok(annotation, 'expected an end-of-line annotation');
  assert.match(annotation, /merged/);
  assert.match(annotation, /⟂/, 'it is still a collision');
  assert.doesNotMatch(annotation, /#\d+/, 'there is no open pull request to name');
});

test('merged work outranks an open pull request on the same line', () => {
  // Both are true, but only one of them has already happened.
  const calls = paint(analysisWith(region(1, 'collision'), mergedRegion(1, 'collision')));
  const annotation = calls
    .flatMap((c) => c.options)
    .map((o) => o.renderOptions?.after?.contentText)
    .find((text): text is string => typeof text === 'string');

  assert.ok(annotation);
  assert.match(annotation, /^⟂ jonchurch · merged/, 'the merged change should lead');
  assert.match(annotation, /\+1/, 'and the pull request should still be counted');
});

test('a multi-line run spans from the first line to the end of the last', () => {
  const calls = paint(analysisWith(region(0, 'collision'), region(1, 'collision')));
  const ranges = calls.flatMap((c) => c.options).filter((o) => o.hoverMessage).map((o) => o.range);

  const spanning = ranges.find((r) => r.start.line === 0 && r.end.line === 1);
  assert.ok(spanning, `expected a run covering lines 0-1, got ${JSON.stringify(ranges)}`);
  assert.equal(spanning.end.character, LINES[1].length);
});

test('the last line of a file does not produce an out-of-range position', () => {
  // LINES ends with an empty line; clamping must keep the range inside the document.
  const last = LINES.length - 1;
  const calls = paint(analysisWith(region(last, 'collision')));
  const range = calls.flatMap((c) => c.options).find((o) => o.hoverMessage)?.range;

  assert.ok(range);
  assert.ok(range.end.line <= last, 'must not address a line past the end');
  assert.equal(range.end.character, LINES[last].length);
});

/** Pull the SVG back out of a generated `data:` URI so its shapes can be inspected. */
function decodeIcon(call: Captured): string {
  const icon = call.type.options?.gutterIconPath as { path?: string } | undefined;
  assert.ok(icon?.path, 'decoration has no gutter icon');
  const marker = 'base64,';
  const index = icon.path.indexOf(marker);
  assert.ok(index >= 0, `gutter icon is not a base64 data URI: ${icon.path.slice(0, 40)}`);
  return Buffer.from(icon.path.slice(index + marker.length), 'base64').toString('utf8');
}

test('the collision gutter icon is a filled diamond over the collaborator ray', () => {
  const calls = paint(analysisWith(region(1, 'collision')));
  const svg = decodeIcon(calls.find((c) => c.options.some((o) => o.hoverMessage)) as Captured);

  assert.match(svg, /^<svg [^>]*viewBox="0 0 16 16"/, 'should be a well-formed 16x16 SVG');
  assert.match(svg, /<rect /, 'the collaborator ray should still be drawn');
  assert.match(svg, /<path d="M[\d.]+ 4 L[\d.]+ 8 L[\d.]+ 12 L[\d.]+ 8 Z"/, 'expected a diamond');
  assert.match(svg, /fill="#[0-9a-f]{6}"/i, 'the diamond must be filled, not hollow');
  assert.doesNotMatch(svg, /fill="none"[^>]*stroke-width="1\.2"/, 'that is the near-miss shape');
});

test('a near miss uses the hollow diamond, so the two read differently', () => {
  const calls = paint(analysisWith(region(1, 'nearMiss')));
  const svg = decodeIcon(calls.find((c) => c.options.some((o) => o.hoverMessage)) as Captured);

  assert.match(svg, /fill="none"/, 'a near miss should not be filled in');
});

test('an ambient change draws a plain ray with no diamond at all', () => {
  const calls = paint(analysisWith(region(1, 'ambient')));
  const svg = decodeIcon(calls.find((c) => c.options.some((o) => o.hoverMessage)) as Captured);

  assert.match(svg, /<rect /);
  assert.doesNotMatch(svg, /<path /, 'ambient presence should stay quiet');
});

test('turning decorations off clears instead of drawing', () => {
  const painter = new DecorationPainter(() => {});
  const { editor, captured } = fakeEditor();
  painter.paint(editor, analysisWith(region(1, 'collision')), pullRequests, () => 0, {
    ...config,
    decorationMode: 'off'
  });
  painter.dispose();

  assert.equal(
    captured.every((call) => call.options.length === 0),
    true,
    'nothing should be drawn when decorations are off'
  );
});

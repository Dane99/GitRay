/**
 * Paints collaborator activity into the editor.
 *
 * Two ideas drive the implementation:
 *
 *  - **One mark per line, not per pull request.** Lines are bucketed first, so a line
 *    three people touched gets a single split ray rather than three overlapping icons.
 *  - **Runs, not lines.** Adjacent lines with an identical mark collapse into one range
 *    before being handed to VS Code, which keeps a heavily-edited file at a few dozen
 *    decorations instead of a few thousand.
 */

import * as vscode from 'vscode';
import type { FileAnalysis, PullRequest, ResolvedRegion, Severity } from '../core/types.js';
import type { Config } from '../core/config.js';
import { buildHover } from './hover.js';
import { collisionHex, hueHex, nearMissHex, themeColor } from './colors.js';
import { collisionIcon, nearMissIcon, rayIcon, seamIcon } from './svg.js';
import { hueColorId } from '../model/palette.js';

/** How long a newly-arrived change stays emphasized before settling into ambient. */
const FLASH_MS = 1200;

const AMBIENT_OPACITY = 0.55;
const EMPHASIS_OPACITY = 1;

interface LineBucket {
  hues: number[];
  severity: Severity;
  seam: boolean;
  flash: boolean;
  regions: ResolvedRegion[];
}

export class DecorationPainter implements vscode.Disposable {
  private types = new Map<string, vscode.TextEditorDecorationType>();
  private annotationType: vscode.TextEditorDecorationType;
  /** Which decoration types each editor is currently using, so stale ones can be cleared. */
  private applied = new WeakMap<vscode.TextEditor, Set<string>>();
  private seenRegions = new Map<string, Set<string>>();
  private flashTimers = new Map<string, NodeJS.Timeout>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly requestRepaint: (uri: vscode.Uri) => void) {
    this.annotationType = createAnnotationType();
    this.disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => this.rebuildForTheme())
    );
  }

  /**
   * Theme changes invalidate every gutter icon, since SVG artwork cannot reference a
   * theme color. Drop the cache and let the next paint regenerate at the new palette.
   */
  private rebuildForTheme(): void {
    for (const type of this.types.values()) type.dispose();
    this.types.clear();
    this.annotationType.dispose();
    this.annotationType = createAnnotationType();
    for (const editor of vscode.window.visibleTextEditors) {
      this.requestRepaint(editor.document.uri);
    }
  }

  clear(editor: vscode.TextEditor): void {
    const active = this.applied.get(editor);
    if (active) {
      for (const key of active) {
        const type = this.types.get(key);
        if (type) editor.setDecorations(type, []);
      }
      active.clear();
    }
    editor.setDecorations(this.annotationType, []);
  }

  paint(
    editor: vscode.TextEditor,
    analysis: FileAnalysis,
    pullRequests: ReadonlyMap<number, PullRequest>,
    hueFor: (author: string) => number,
    config: Config
  ): void {
    if (config.decorationMode === 'off') {
      this.clear(editor);
      return;
    }

    const visible = analysis.regions.filter(
      (region) => config.decorationMode !== 'collisionsOnly' || region.severity !== 'ambient'
    );

    const flashing = this.trackArrivals(analysis, editor.document.uri);
    const buckets = bucketByLine(visible, editor.document.lineCount, hueFor, flashing);

    const groups = new Map<string, vscode.DecorationOptions[]>();
    const annotations: vscode.DecorationOptions[] = [];

    for (const run of collapseRuns(buckets)) {
      const key = signature(run.bucket);

      // Cover the actual text of the run. `run.end` is inclusive, so stopping at column 0
      // of it would leave a single-line region as an empty range — which still paints a
      // whole-line background and a ruler mark, but has no text to hover, so the card
      // would never appear.
      const lastLine = Math.min(run.end, editor.document.lineCount - 1);
      const range = new vscode.Range(
        run.start,
        0,
        lastLine,
        editor.document.lineAt(lastLine).text.length
      );

      const options: vscode.DecorationOptions = {
        range,
        hoverMessage: buildHover(run.bucket.regions, pullRequests, analysis.path)
      };

      const existing = groups.get(key);
      if (existing) existing.push(options);
      else groups.set(key, [options]);
    }

    if (config.showInlineAnnotations) {
      annotations.push(...buildAnnotations(buckets, editor, pullRequests));
    }

    // Clear types this editor used last time but does not use now, then apply the new set.
    const previous = this.applied.get(editor) ?? new Set<string>();
    for (const key of previous) {
      if (!groups.has(key)) {
        const type = this.types.get(key);
        if (type) editor.setDecorations(type, []);
      }
    }

    const nowApplied = new Set<string>();
    for (const [key, options] of groups) {
      editor.setDecorations(this.typeFor(key), options);
      nowApplied.add(key);
    }
    this.applied.set(editor, nowApplied);
    editor.setDecorations(this.annotationType, annotations);
  }

  /**
   * Spot changes that appeared since the last paint of this file.
   *
   * The brief emphasis this produces is the one bit of motion the decoration API allows,
   * and it is what makes a teammate's push feel like it arrived rather than like it had
   * always been there. A file's first paint never flashes — everything is new then, and
   * strobing the whole gutter on open would be the opposite of calm.
   */
  private trackArrivals(analysis: FileAnalysis, uri: vscode.Uri): Set<string> {
    const key = analysis.path;
    const current = new Set(analysis.regions.map(regionKey));
    const previous = this.seenRegions.get(key);
    this.seenRegions.set(key, current);

    if (!previous) return new Set();

    const arrived = new Set<string>();
    for (const id of current) {
      if (!previous.has(id)) arrived.add(id);
    }
    if (arrived.size === 0) return arrived;

    const existingTimer = this.flashTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    this.flashTimers.set(
      key,
      setTimeout(() => {
        this.flashTimers.delete(key);
        this.requestRepaint(uri);
      }, FLASH_MS)
    );

    return arrived;
  }

  /** Drop per-file arrival tracking, e.g. when the document closed. */
  forget(path: string): void {
    this.seenRegions.delete(path);
    const timer = this.flashTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      this.flashTimers.delete(path);
    }
  }

  private typeFor(key: string): vscode.TextEditorDecorationType {
    let type = this.types.get(key);
    if (!type) {
      type = createType(key);
      this.types.set(key, type);
    }
    return type;
  }

  dispose(): void {
    for (const timer of this.flashTimers.values()) clearTimeout(timer);
    this.flashTimers.clear();
    for (const type of this.types.values()) type.dispose();
    this.types.clear();
    this.annotationType.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function regionKey(region: ResolvedRegion): string {
  return `${region.prNumber}:${region.baseSha}:${region.baseRange.start}-${region.baseRange.end}`;
}

/** Fold overlapping regions down to one mark per line. */
function bucketByLine(
  regions: readonly ResolvedRegion[],
  lineCount: number,
  hueFor: (author: string) => number,
  flashing: ReadonlySet<string>
): Map<number, LineBucket> {
  const buckets = new Map<number, LineBucket>();

  const add = (line: number, region: ResolvedRegion, seam: boolean) => {
    if (line < 0 || line >= lineCount) return;

    let bucket = buckets.get(line);
    if (!bucket) {
      bucket = { hues: [], severity: 'ambient', seam: false, flash: false, regions: [] };
      buckets.set(line, bucket);
    }

    const hue = hueFor(region.author);
    if (!bucket.hues.includes(hue)) bucket.hues.push(hue);
    if (rank(region.severity) > rank(bucket.severity)) bucket.severity = region.severity;
    bucket.seam ||= seam;
    bucket.flash ||= flashing.has(regionKey(region));
    if (!bucket.regions.includes(region)) bucket.regions.push(region);
  };

  for (const region of regions) {
    const { start, end } = region.range;
    if (start === end) {
      // An insertion has no lines of its own; mark the seam it landed on.
      add(Math.min(start, lineCount - 1), region, true);
      continue;
    }
    for (let line = start; line < end; line++) {
      add(line, region, false);
    }
  }

  for (const bucket of buckets.values()) {
    bucket.hues.sort((a, b) => a - b);
  }

  return buckets;
}

interface Run {
  start: number;
  end: number;
  bucket: LineBucket;
}

/** Merge consecutive lines carrying an identical mark into one range. */
function collapseRuns(buckets: ReadonlyMap<number, LineBucket>): Run[] {
  const lines = [...buckets.keys()].sort((a, b) => a - b);
  const runs: Run[] = [];

  let current: Run | undefined;
  for (const line of lines) {
    const bucket = buckets.get(line) as LineBucket;
    if (current && line === current.end + 1 && signature(bucket) === signature(current.bucket)) {
      current.end = line;
      // Keep the hover complete across the merged span.
      for (const region of bucket.regions) {
        if (!current.bucket.regions.includes(region)) current.bucket.regions.push(region);
      }
      continue;
    }
    current = { start: line, end: line, bucket };
    runs.push(current);
  }

  return runs;
}

function rank(severity: Severity): number {
  return severity === 'collision' ? 2 : severity === 'nearMiss' ? 1 : 0;
}

/** Encode everything that affects appearance; equal signatures share a decoration type. */
function signature(bucket: LineBucket): string {
  return [
    bucket.severity,
    bucket.seam ? 'seam' : 'span',
    bucket.flash ? 'flash' : 'calm',
    bucket.hues.join('.')
  ].join('|');
}

function createType(key: string): vscode.TextEditorDecorationType {
  const [severity, shape, flash, hueList] = key.split('|');
  const hues = hueList === '' ? [] : hueList.split('.').map(Number);
  const colors = hues.map(hueHex);
  const opacity = flash === 'flash' ? EMPHASIS_OPACITY : AMBIENT_OPACITY;

  const options: vscode.DecorationRenderOptions = {
    gutterIconSize: 'contain',
    // Anchor the mark rather than letting it grow with adjacent typing; the next analysis
    // pass is what should move it, not incidental keystrokes.
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    overviewRulerLane:
      severity === 'collision' ? vscode.OverviewRulerLane.Center : vscode.OverviewRulerLane.Right
  };

  if (severity === 'collision') {
    options.gutterIconPath = collisionIcon(colors, collisionHex());
    options.overviewRulerColor = themeColor('gitray.collisionForeground');
    options.backgroundColor = themeColor('gitray.collisionBackground');
    options.isWholeLine = true;
  } else if (severity === 'nearMiss') {
    options.gutterIconPath = nearMissIcon(colors, nearMissHex());
    options.overviewRulerColor = themeColor('gitray.nearMissForeground');
  } else if (shape === 'seam') {
    options.gutterIconPath = seamIcon(colors[0] ?? hueHex(0), opacity);
    options.overviewRulerColor = themeColor(hueColorId(hues[0] ?? 0));
  } else {
    options.gutterIconPath = rayIcon(colors, opacity);
    options.overviewRulerColor = themeColor(hueColorId(hues[0] ?? 0));
  }

  return vscode.window.createTextEditorDecorationType(options);
}

function createAnnotationType(): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    after: {
      color: themeColor('gitray.annotationForeground'),
      fontStyle: 'italic',
      margin: '0 0 0 2.5em'
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
}

/**
 * End-of-line notes.
 *
 * Kept scarce on purpose. Every collision gets one, because that is the state worth
 * interrupting for, and the region under the cursor gets one, because that is what you
 * are asking about. Annotating every ambient line would turn the file into a changelog.
 */
function buildAnnotations(
  buckets: ReadonlyMap<number, LineBucket>,
  editor: vscode.TextEditor,
  pullRequests: ReadonlyMap<number, PullRequest>
): vscode.DecorationOptions[] {
  const cursorLine = editor.selection.active.line;
  const annotations: vscode.DecorationOptions[] = [];
  const annotated = new Set<number>();

  const emit = (line: number, bucket: LineBucket) => {
    if (annotated.has(line) || line >= editor.document.lineCount) return;
    annotated.add(line);

    const primary = bucket.regions[0];
    if (!primary) return;

    const others = bucket.regions.length - 1;
    const pr = pullRequests.get(primary.prNumber);
    const mark = bucket.severity === 'collision' ? '⟂' : '·';
    const suffix = others > 0 ? ` +${others}` : '';
    const title = bucket.severity === 'collision' && pr ? ` ${truncate(pr.title, 40)}` : '';

    annotations.push({
      range: new vscode.Range(line, editor.document.lineAt(line).text.length, line, editor.document.lineAt(line).text.length),
      renderOptions: {
        after: { contentText: `${mark} ${primary.author} #${primary.prNumber}${suffix}${title}` }
      }
    });
  };

  // First line of every collision run.
  let previousWasCollision = false;
  for (const line of [...buckets.keys()].sort((a, b) => a - b)) {
    const bucket = buckets.get(line) as LineBucket;
    const isCollision = bucket.severity === 'collision';
    if (isCollision && !previousWasCollision) emit(line, bucket);
    previousWasCollision = isCollision;
  }

  const atCursor = buckets.get(cursorLine);
  if (atCursor) emit(cursorLine, atCursor);

  return annotations;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

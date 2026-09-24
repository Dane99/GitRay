/**
 * Keeps the visible editors in sync with the store.
 *
 * Work is scoped to what is on screen: a repository can have thirty open pull requests
 * touching hundreds of files, but only the handful of documents actually visible need
 * line-level analysis. Everything else is served by the file-level index.
 */

import * as vscode from 'vscode';
import type { FileAnalysis, PullRequest } from '../core/types.js';
import type { Config } from '../core/config.js';
import { log } from '../core/log.js';
import { matchesAny } from '../core/glob.js';
import type { Analyzer } from '../model/analyzer.js';
import type { Store } from '../model/store.js';
import type { Repository } from '../providers/repository.js';
import { DecorationPainter } from './decorations.js';

const TYPING_DEBOUNCE_MS = 250;

/**
 * How long a burst of store changes is gathered before the visible editors re-analyze.
 *
 * A sync pass can change the store several times in a row, and each change used to start
 * an analysis of every visible file.
 */
const STORE_DEBOUNCE_MS = 50;

export class EditorController implements vscode.Disposable {
  private readonly painter: DecorationPainter;
  private readonly analyses = new Map<string, FileAnalysis>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  /** Guards against a slow analysis overwriting a newer one for the same document. */
  private readonly generation = new Map<string, number>();
  /** The cursor line each editor's annotations were last drawn for. */
  private readonly cursorLines = new WeakMap<vscode.TextEditor, number>();
  /** The open pull requests by number, rebuilt only when the store's list changes. */
  private byNumber: { source: readonly PullRequest[]; map: Map<number, PullRequest> } | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly repository: Repository,
    private readonly store: Store,
    private readonly analyzer: Analyzer,
    private readonly config: () => Config
  ) {
    this.painter = new DecorationPainter(repository.root, (uri) => this.schedule(uri, 0));

    this.disposables.push(
      this.painter,

      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshVisible()),

      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.tracks(event.document.uri)) {
          this.schedule(event.document.uri, TYPING_DEBOUNCE_MS);
        }
      }),

      vscode.workspace.onDidCloseTextDocument((document) => {
        const key = document.uri.toString();
        this.analyses.delete(key);
        const timer = this.pending.get(key);
        if (timer) {
          clearTimeout(timer);
          this.pending.delete(key);
        }
        // The painter tracks arrival state per file; without this it accumulates an
        // entry for every document ever opened in the session.
        const path = this.repository.relativePath(document.uri);
        if (path) this.painter.forget(path);
      }),

      // Selection moves change which region gets an inline annotation, and nothing else.
      // So only the annotation is redrawn, and only when the cursor changed line — typing
      // moves the selection on every keystroke, and repainting every gutter mark and
      // rebuilding every hover card each time is what made typing lag.
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const editor = event.textEditor;
        const line = editor.selection.active.line;
        if (this.cursorLines.get(editor) === line) return;
        this.cursorLines.set(editor, line);
        this.painter.paintAnnotations(editor, this.config());
      }),

      this.store.onDidChange(() => this.refreshVisible(STORE_DEBOUNCE_MS))
    );
  }

  private tracks(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && this.repository.relativePath(uri) !== undefined;
  }

  refreshVisible(delay = 0): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.tracks(editor.document.uri)) this.schedule(editor.document.uri, delay);
      else this.painter.clear(editor);
    }
  }

  private schedule(uri: vscode.Uri, delay: number): void {
    const key = uri.toString();
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing);

    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        void this.run(uri);
      }, delay)
    );
  }

  private async run(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const relativePath = this.repository.relativePath(uri);
    if (!relativePath) return;

    const editors = vscode.window.visibleTextEditors.filter(
      (editor) => editor.document.uri.toString() === key
    );
    if (editors.length === 0) return;

    const config = this.config();
    if (matchesAny(relativePath, config.ignoreGlobs)) {
      for (const editor of editors) this.painter.clear(editor);
      return;
    }

    const document = editors[0].document;
    const generation = (this.generation.get(key) ?? 0) + 1;
    this.generation.set(key, generation);

    let analysis: FileAnalysis;
    try {
      analysis = await this.analyzer.analyze(
        relativePath,
        document.getText(),
        document.version,
        this.store.allPullRequests(),
        {
          proximityLines: config.proximityLines,
          maxRegionsPerFile: config.maxRegionsPerFile,
          mainline: config.trackMainlineDrift ? this.store.mainline() : undefined
        }
      );
    } catch (error) {
      log.error(`analysis failed for ${relativePath}`, error);
      return;
    }

    // A newer pass started while this one was awaiting git; its result is the current one.
    if (this.generation.get(key) !== generation) return;

    this.analyses.set(key, analysis);
    for (const editor of editors) this.paint(editor, analysis);
  }

  private paint(editor: vscode.TextEditor, analysis: FileAnalysis): void {
    this.cursorLines.set(editor, editor.selection.active.line);
    this.painter.paint(
      editor,
      analysis,
      this.pullRequestsByNumber(),
      (region) => this.store.hueForRegion(region),
      this.config()
    );
  }

  private pullRequestsByNumber(): Map<number, PullRequest> {
    const source = this.store.allPullRequests();
    if (this.byNumber?.source !== source) {
      this.byNumber = { source, map: new Map(source.map((pr) => [pr.number, pr])) };
    }
    return this.byNumber.map;
  }

  analysisFor(uri: vscode.Uri): FileAnalysis | undefined {
    return this.analyses.get(uri.toString());
  }

  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
  }
}

/**
 * Keeps the visible editors in sync with the store.
 *
 * Work is scoped to what is on screen: a repository can have thirty open pull requests
 * touching hundreds of files, but only the handful of documents actually visible need
 * line-level analysis. Everything else is served by the file-level index.
 */

import * as vscode from 'vscode';
import type { FileAnalysis, PullRequest } from '../core/types.js';
import { readConfig } from '../core/config.js';
import { log } from '../core/log.js';
import { matchesAny } from '../core/glob.js';
import type { Analyzer } from '../model/analyzer.js';
import type { Store } from '../model/store.js';
import type { Repository } from '../providers/repository.js';
import { DecorationPainter } from './decorations.js';

const TYPING_DEBOUNCE_MS = 250;

export class EditorController implements vscode.Disposable {
  private readonly painter: DecorationPainter;
  private readonly analyses = new Map<string, FileAnalysis>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  /** Guards against a slow analysis overwriting a newer one for the same document. */
  private readonly generation = new Map<string, number>();
  private disposables: vscode.Disposable[] = [];

  private readonly onDidChangeAnalysisEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeAnalysis = this.onDidChangeAnalysisEmitter.event;

  constructor(
    private readonly repository: Repository,
    private readonly store: Store,
    private readonly analyzer: Analyzer
  ) {
    this.painter = new DecorationPainter((uri) => this.schedule(uri, 0));

    this.disposables.push(
      this.painter,
      this.onDidChangeAnalysisEmitter,

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
      }),

      // Selection moves change which region gets an inline annotation, so repaint from
      // the cached analysis. No git work is involved.
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const analysis = this.analyses.get(event.textEditor.document.uri.toString());
        if (analysis) this.paint(event.textEditor, analysis);
      }),

      this.store.onDidChange(() => this.refreshVisible())
    );
  }

  private tracks(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && this.repository.relativePath(uri) !== undefined;
  }

  refreshVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.tracks(editor.document.uri)) this.schedule(editor.document.uri, 0);
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

    const config = readConfig(this.repository.folder.uri);
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
          maxRegionsPerFile: config.maxRegionsPerFile
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
    this.onDidChangeAnalysisEmitter.fire();
  }

  private paint(editor: vscode.TextEditor, analysis: FileAnalysis): void {
    const config = readConfig(this.repository.folder.uri);
    const pullRequests = new Map<number, PullRequest>(
      this.store.allPullRequests().map((pr) => [pr.number, pr])
    );
    this.painter.paint(editor, analysis, pullRequests, (author) => this.store.hueFor(author), config);
  }

  analysisFor(uri: vscode.Uri): FileAnalysis | undefined {
    return this.analyses.get(uri.toString());
  }

  /** Collision count across every analyzed document, for the status bar. */
  visibleCollisionCount(): number {
    let count = 0;
    for (const analysis of this.analyses.values()) {
      count += analysis.regions.filter((region) => region.severity === 'collision').length;
    }
    return count;
  }

  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
  }
}

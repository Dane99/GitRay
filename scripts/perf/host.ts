/**
 * A VS Code for the extension to run in, faithful where performance is decided.
 *
 * Built on the test suite's stub, with the parts that stub leaves inert brought to life:
 *
 *  - **An editor you can type in.** Documents with versions, an editor that records every
 *    `setDecorations`, and real events for edits, cursor moves, saves, and visibility.
 *  - **A sidebar that re-reads itself.** When the tree announces a change the stub walks
 *    every expanded row, the way the workbench does, so the cost of building the tree is
 *    measured rather than skipped.
 *  - **An explorer that asks for badges.** A decoration change is answered by querying
 *    the files the explorer would be showing.
 *
 * Both of the last two run a tick later, as the real ones do across the process boundary,
 * but on the same thread — the extension pays for them either way.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { makeVscodeStub, type VscodeStub } from '../../test/integration/vscodeStub.js';
import { touch } from './instrument.js';

type Listener<T> = (value: T) => void;

interface Emitter<T> {
  event: (listener: Listener<T>) => { dispose(): void };
  fire(value: T): void;
}

export interface SurfaceCost {
  /** Time spent building sidebar rows. */
  treeMs: number;
  treeWalks: number;
  treeRows: number;
  /** Time spent answering explorer badge queries. */
  badgeMs: number;
  badgeQueries: number;
  /** `setDecorations` calls across every editor. */
  decorationCalls: number;
}

export interface Host {
  stub: VscodeStub;
  api: Record<string, any>;
  surfaces: SurfaceCost;
  /** Everything the extension wrote to its log, in order. */
  log: string[];
  /** Files the explorer would show when asked about "everything". */
  setExplorerRows(paths: readonly string[]): void;
  openEditor(path: string, cursorLine: number): FakeEditor;
  fire: {
    textChange(editor: FakeEditor): number;
    selection(editor: FakeEditor): number;
    save(editor: FakeEditor): number;
  };
}

export interface FakeEditor {
  document: FakeDocument;
  selection: { active: { line: number; character: number }; anchor: { line: number; character: number } };
  setDecorations(type: unknown, options: unknown[]): void;
  /** Move the cursor, the way an arrow key does. */
  moveTo(line: number): void;
  /** Type one character at the end of the cursor's line. */
  type(char: string): void;
}

export interface FakeDocument {
  uri: any;
  fileName: string;
  languageId: string;
  version: number;
  isDirty: boolean;
  lines: string[];
  eol: string;
  getText(): string;
  readonly lineCount: number;
  lineAt(line: number): { text: string; lineNumber: number };
}

export function createHost(root: string): Host {
  const stub = makeVscodeStub(root);
  const api = stub.api as Record<string, any>;
  const surfaces: SurfaceCost = {
    treeMs: 0,
    treeWalks: 0,
    treeRows: 0,
    badgeMs: 0,
    badgeQueries: 0,
    decorationCalls: 0
  };
  const log: string[] = [];
  let explorerRows: readonly string[] = [];

  const emitter = <T>(): Emitter<T> => new api.EventEmitter() as Emitter<T>;
  const textChanged = emitter<unknown>();
  const selectionChanged = emitter<unknown>();
  const visibleChanged = emitter<unknown>();
  const saved = emitter<unknown>();
  const closed = emitter<unknown>();

  api.workspace.onDidChangeTextDocument = textChanged.event;
  api.workspace.onDidSaveTextDocument = saved.event;
  api.workspace.onDidCloseTextDocument = closed.event;
  api.window.onDidChangeTextEditorSelection = selectionChanged.event;
  api.window.onDidChangeVisibleTextEditors = visibleChanged.event;

  // --- The log -------------------------------------------------------------------------

  const channel = (level: string) => (message: unknown, ...rest: unknown[]) => {
    const text = message instanceof Error ? `${rest[0] ?? ''} ${message.stack ?? message.message}` : String(message);
    log.push(`${new Date().toISOString()} [${level}] ${text}`);
    if (level === 'error') stub.errors.push(text);
  };
  api.window.createOutputChannel = () => ({
    trace: channel('trace'),
    debug: channel('debug'),
    info: channel('info'),
    warn: channel('warn'),
    error: channel('error'),
    show: () => {},
    dispose: () => {}
  });

  // --- The sidebar -----------------------------------------------------------------------

  api.window.createTreeView = (id: string, options: { treeDataProvider: any }) => {
    stub.treeViews.push(id);
    const provider = options.treeDataProvider;
    let pending: NodeJS.Timeout | undefined;

    const walk = async () => {
      pending = undefined;
      const started = performance.now();
      let rows = 0;
      const visit = async (node: unknown): Promise<void> => {
        const children = ((await provider.getChildren(node)) ?? []) as unknown[];
        for (const child of children) {
          rows++;
          const item = await provider.getTreeItem(child);
          // Expanded rows are read at once; collapsed ones wait for a click.
          if (item?.collapsibleState === api.TreeItemCollapsibleState.Expanded) await visit(child);
        }
      };
      await visit(undefined);
      surfaces.treeMs += performance.now() - started;
      surfaces.treeWalks++;
      surfaces.treeRows += rows;
      touch();
    };

    provider.onDidChangeTreeData?.(() => {
      // The workbench coalesces refreshes that arrive together into one re-read.
      pending ??= setTimeout(() => void walk(), 0);
    });
    pending = setTimeout(() => void walk(), 0);
    return { dispose: () => {}, visible: true, reveal: async () => {} };
  };

  // --- The explorer --------------------------------------------------------------------

  api.window.registerFileDecorationProvider = (provider: any) => {
    stub.fileDecorationProviders++;
    provider.onDidChangeFileDecorations?.((uris: unknown) => {
      setTimeout(() => {
        const started = performance.now();
        const asked = Array.isArray(uris)
          ? uris
          : explorerRows.map((path) => api.Uri.file(join(root, ...path.split('/'))));
        for (const uri of asked) {
          provider.provideFileDecoration(uri);
          surfaces.badgeQueries++;
        }
        surfaces.badgeMs += performance.now() - started;
        touch();
      }, 0);
    });
    return new api.Disposable();
  };

  // --- Editors -------------------------------------------------------------------------

  const openEditor = (path: string, cursorLine: number): FakeEditor => {
    const fsPath = join(root, ...path.split('/'));
    const text = readFileSync(fsPath, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);

    const document: FakeDocument = {
      uri: api.Uri.file(fsPath),
      fileName: fsPath,
      languageId: 'plaintext',
      version: 1,
      isDirty: false,
      lines,
      eol,
      getText: () => lines.join(eol),
      get lineCount() {
        return lines.length;
      },
      lineAt: (line: number) => ({ text: lines[line] ?? '', lineNumber: line })
    };

    const position = (line: number) => ({ line, character: (lines[line] ?? '').length });
    const editor: FakeEditor = {
      document,
      selection: { active: position(cursorLine), anchor: position(cursorLine) },
      setDecorations: () => {
        surfaces.decorationCalls++;
        touch();
      },
      moveTo(line: number) {
        const clamped = Math.max(0, Math.min(line, lines.length - 1));
        editor.selection = { active: position(clamped), anchor: position(clamped) };
      },
      type(char: string) {
        const line = editor.selection.active.line;
        lines[line] = (lines[line] ?? '') + char;
        document.version++;
        document.isDirty = true;
        editor.selection = { active: position(line), anchor: position(line) };
      }
    };

    api.window.visibleTextEditors = [editor];
    api.window.activeTextEditor = editor;
    (api.workspace.textDocuments as unknown[]).push(document);
    visibleChanged.fire([editor]);
    return editor;
  };

  const timedFire = (fire: () => void): number => {
    const started = performance.now();
    fire();
    touch();
    return performance.now() - started;
  };

  return {
    stub,
    api,
    surfaces,
    log,
    setExplorerRows: (paths) => {
      explorerRows = paths;
    },
    openEditor,
    fire: {
      textChange: (editor) =>
        timedFire(() =>
          textChanged.fire({ document: editor.document, contentChanges: [{}], reason: undefined })
        ),
      selection: (editor) =>
        timedFire(() =>
          selectionChanged.fire({ textEditor: editor, selections: [editor.selection], kind: 1 })
        ),
      save: (editor) =>
        timedFire(() => {
          editor.document.isDirty = false;
          saved.fire(editor.document);
        })
    }
  };
}

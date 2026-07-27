/**
 * A stand-in for the `vscode` module, faithful enough to activate the real bundle.
 *
 * Only the surface GitRay actually touches is implemented. Defaults for settings are read
 * from package.json rather than duplicated here, so the stub cannot drift away from what
 * the extension really sees at runtime.
 */

import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, sep, normalize, dirname } from 'node:path';

/**
 * Locate the extension root by walking up to the nearest package.json.
 *
 * Deriving it from a fixed number of `..` segments breaks the moment this file moves or
 * is loaded through a transform that rewrites `__dirname`, and the resulting failure is
 * a confusing ENOENT rather than anything that names the real problem.
 */
function findProjectRoot(): string {
  let current = __dirname;
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`could not locate package.json above ${__dirname}`);
}

interface StatusBarRecord {
  text: string;
  tooltipHistory: unknown[];
  disposed: boolean;
}

export interface VscodeStub {
  api: Record<string, unknown>;
  context: Record<string, unknown>;
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  treeViews: string[];
  statusBarItems: StatusBarRecord[];
  contentProviderSchemes: string[];
  fileDecorationProviders: number;
  errors: string[];
  disposedCount: number;
}

export function makeVscodeStub(repoRoot: string): VscodeStub {
  const projectRoot = findProjectRoot();
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  const settingDefaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries<{ default?: unknown }>(
    manifest.contributes.configuration.properties
  )) {
    settingDefaults[key] = value.default;
  }

  const state: VscodeStub = {
    api: {},
    context: {},
    registeredCommands: new Map(),
    treeViews: [],
    statusBarItems: [],
    contentProviderSchemes: [],
    fileDecorationProviders: 0,
    errors: [],
    disposedCount: 0
  };

  class Disposable {
    constructor(private readonly callOnDispose: () => void = () => {}) {}
    dispose(): void {
      state.disposedCount++;
      this.callOnDispose();
    }
    static from(...items: { dispose(): unknown }[]): Disposable {
      return new Disposable(() => {
        for (const item of items) item.dispose();
      });
    }
  }

  const noopDisposable = () => new Disposable();

  class EventEmitter<T> {
    private listeners: ((value: T) => void)[] = [];
    readonly event = (listener: (value: T) => void): Disposable => {
      this.listeners.push(listener);
      return new Disposable(() => {
        this.listeners = this.listeners.filter((candidate) => candidate !== listener);
      });
    };
    fire(value: T): void {
      for (const listener of [...this.listeners]) listener(value);
    }
    dispose(): void {
      this.listeners = [];
    }
  }

  /** Minimal Uri: enough for path round-tripping and scheme checks. */
  class Uri {
    constructor(
      readonly scheme: string,
      readonly authority: string,
      readonly path: string,
      readonly query = '',
      readonly fragment = ''
    ) {}

    get fsPath(): string {
      const raw = this.path.replace(/^\/([a-zA-Z]:)/, '$1');
      return normalize(raw.split('/').join(sep));
    }

    static file(fsPath: string): Uri {
      const normalized = fsPath.split(sep).join('/');
      return new Uri('file', '', normalized.startsWith('/') ? normalized : `/${normalized}`);
    }

    static parse(value: string): Uri {
      const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?/.exec(value);
      if (!match) return new Uri('file', '', value);
      return new Uri(match[1], match[2] ?? '', match[3] ?? '', match[4] ?? '');
    }

    static from(parts: { scheme: string; authority?: string; path?: string; query?: string }): Uri {
      return new Uri(parts.scheme, parts.authority ?? '', parts.path ?? '', parts.query ?? '');
    }

    static joinPath(base: Uri, ...segments: string[]): Uri {
      return new Uri(base.scheme, base.authority, [base.path, ...segments].join('/'));
    }

    toString(): string {
      const query = this.query ? `?${this.query}` : '';
      return `${this.scheme}://${this.authority}${this.path}${query}`;
    }
  }

  class Position {
    constructor(
      readonly line: number,
      readonly character: number
    ) {}
  }

  class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(
      startLine: number | Position,
      startChar: number | Position,
      endLine?: number,
      endChar?: number
    ) {
      if (typeof startLine === 'number') {
        this.start = new Position(startLine, startChar as number);
        this.end = new Position(endLine as number, endChar as number);
      } else {
        this.start = startLine;
        this.end = startChar as Position;
      }
    }
  }

  class Selection extends Range {}

  class MarkdownString {
    value = '';
    isTrusted: unknown = false;
    supportHtml = false;
    constructor(
      value?: string,
      readonly supportThemeIcons = false
    ) {
      if (value) this.value = value;
    }
    appendMarkdown(text: string): this {
      this.value += text;
      return this;
    }
    appendCodeblock(code: string, language = ''): this {
      this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
      return this;
    }
  }

  class TreeItem {
    label: unknown;
    description: unknown;
    iconPath: unknown;
    tooltip: unknown;
    command: unknown;
    contextValue: unknown;
    resourceUri: unknown;
    constructor(
      label: unknown,
      readonly collapsibleState?: number
    ) {
      this.label = label;
    }
  }

  const outputChannel = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: unknown) => {
      state.errors.push(message instanceof Error ? message.message : String(message));
    },
    show: () => {},
    dispose: () => {
      state.disposedCount++;
    }
  };

  const api = {
    version: '1.90.0',

    Disposable,
    EventEmitter,
    Uri,
    Position,
    Range,
    Selection,
    MarkdownString,
    TreeItem,
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    ThemeIcon: class {
      constructor(
        readonly id: string,
        readonly color?: unknown
      ) {}
    },
    RelativePattern: class {
      constructor(
        readonly base: unknown,
        readonly pattern: string
      ) {}
    },
    FileDecoration: class {},

    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    ViewColumn: { Active: -1, One: 1 },

    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [] as unknown[],
      state: { focused: true },
      activeColorTheme: { kind: 2 },

      createOutputChannel: () => outputChannel,

      createTreeView: (id: string) => {
        state.treeViews.push(id);
        return { dispose: () => state.disposedCount++, visible: false };
      },

      createStatusBarItem: () => {
        const record: StatusBarRecord = { text: '', tooltipHistory: [], disposed: false };
        state.statusBarItems.push(record);
        return {
          name: '',
          command: '',
          get text() {
            return record.text;
          },
          set text(value: string) {
            record.text = value;
          },
          set tooltip(value: unknown) {
            record.tooltipHistory.push(value);
          },
          backgroundColor: undefined,
          show: () => {},
          hide: () => {},
          dispose: () => {
            record.disposed = true;
            state.disposedCount++;
          }
        };
      },

      // Return the options so tests can tell which decoration type is which.
      createTextEditorDecorationType: (options: unknown) => ({
        options,
        dispose: () => state.disposedCount++
      }),
      createWebviewPanel: () => {
        throw new Error('createWebviewPanel is not exercised by the activation test');
      },
      registerWebviewPanelSerializer: noopDisposable,
      registerFileDecorationProvider: () => {
        state.fileDecorationProviders++;
        return new Disposable();
      },

      onDidChangeActiveColorTheme: () => new Disposable(),
      onDidChangeVisibleTextEditors: () => new Disposable(),
      onDidChangeTextEditorSelection: () => new Disposable(),
      onDidChangeWindowState: () => new Disposable(),

      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showQuickPick: async () => undefined,
      showOpenDialog: async () => undefined,
      showTextDocument: async () => ({ selection: undefined, revealRange: () => {} }),
      setStatusBarMessage: () => new Disposable()
    },

    workspace: {
      workspaceFolders: [{ uri: Uri.file(repoRoot), name: 'test', index: 0 }],
      textDocuments: [] as unknown[],

      getConfiguration: (section: string) => ({
        get: (key: string, fallback?: unknown) => {
          const full = section ? `${section}.${key}` : key;
          return full in settingDefaults ? settingDefaults[full] : fallback;
        },
        update: async () => {}
      }),

      createFileSystemWatcher: () => ({
        onDidChange: () => new Disposable(),
        onDidCreate: () => new Disposable(),
        onDidDelete: () => new Disposable(),
        dispose: () => state.disposedCount++
      }),

      registerTextDocumentContentProvider: (scheme: string) => {
        state.contentProviderSchemes.push(scheme);
        return new Disposable();
      },

      onDidSaveTextDocument: () => new Disposable(),
      onDidChangeTextDocument: () => new Disposable(),
      onDidCloseTextDocument: () => new Disposable(),
      onDidChangeConfiguration: () => new Disposable(),
      onDidChangeWorkspaceFolders: () => new Disposable(),

      openTextDocument: async () => ({ getText: () => '', version: 1, lineCount: 0 }),

      fs: {
        readFile: async (uri: { fsPath: string }) => new Uint8Array(await readFile(uri.fsPath))
      }
    },

    commands: {
      registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
        state.registeredCommands.set(name, handler);
        return new Disposable(() => state.registeredCommands.delete(name));
      },
      executeCommand: async () => undefined
    },

    env: {
      openExternal: async () => true
    },

    languages: {
      registerHoverProvider: noopDisposable
    }
  };

  state.api = api as unknown as Record<string, unknown>;
  state.context = {
    subscriptions: [] as { dispose(): unknown }[],
    extensionUri: Uri.file(projectRoot)
  };

  return state;
}

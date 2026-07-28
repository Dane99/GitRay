/**
 * A stand-in for the `vscode` module, faithful enough to activate the real bundle.
 *
 * Only the surface GitRay actually touches is implemented. Defaults for settings are read
 * from package.json rather than duplicated here, so the stub cannot drift away from what
 * the extension really sees at runtime.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, sep, normalize, dirname, basename } from 'node:path';

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
  /**
   * Whether the item is currently on screen.
   *
   * Worth recording because hiding is how this surface fails invisibly: an item that never
   * shows looks exactly like an item with nothing to report, and no assertion on `text`
   * can tell the two apart.
   */
  visible: boolean;
}

export interface VscodeStub {
  api: Record<string, unknown>;
  context: Record<string, unknown>;
  /**
   * Settings written by `update`, keyed by their full id, over the manifest defaults.
   *
   * Tests seed this to stand in for a user's settings.json, and read it back to assert on
   * what a command wrote. Writes fire `onDidChangeConfiguration`, the way a real host does.
   */
  settings: Record<string, unknown>;
  /**
   * Settings written to `ConfigurationTarget.WorkspaceFolder`, keyed by folder path.
   *
   * The point of the separation: a mute belongs to the repository it was made in, and a
   * test can only prove that by checking it did *not* land in the shared list above.
   */
  folderSettings: Record<string, Record<string, unknown>>;
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  /** What `vscode.authentication.getSession` hands back. Undefined means "never signed in". */
  githubSession: { accessToken: string; account: { label: string } } | undefined;
  /** Every session request, so a test can assert that polling never asks interactively. */
  sessionRequests: { providerId: string; scopes: string[]; interactive: boolean }[];
  treeViews: string[];
  statusBarItems: StatusBarRecord[];
  contentProviderSchemes: string[];
  fileDecorationProviders: number;
  /**
   * Every file system watcher created, by the path it watches.
   *
   * The head watcher is created once per session and nowhere else, which makes this the
   * cheapest way to count how many repositories are genuinely attached.
   */
  watchedPatterns: { base: string; pattern: string; disposed: boolean }[];
  /**
   * Panels handed to the webview serializer for restore.
   *
   * `disposed` is the interesting field: an extension that gives up on a restore throws
   * the panel away, and from the user's side that is a Radar tab vanishing on reload.
   */
  restoredPanels: { disposed: boolean; title: string }[];
  /** The last value published for each `setContext` key. */
  contextKeys: Record<string, unknown>;
  errors: string[];
  disposedCount: number;
  /** Replace the folder list and fire `onDidChangeWorkspaceFolders`, as the host does. */
  setWorkspaceFolders(roots: string[]): void;
}

/**
 * @param roots One workspace folder per path, in order. Several of them is what a
 *   multi-root workspace is, and it is the only way to exercise the folder-scoped
 *   configuration target and the per-repository lookups above it.
 */
export function makeVscodeStub(...roots: string[]): VscodeStub {
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
    settings: {},
    folderSettings: {},
    registeredCommands: new Map(),
    githubSession: undefined,
    sessionRequests: [],
    treeViews: [],
    statusBarItems: [],
    contentProviderSchemes: [],
    fileDecorationProviders: 0,
    watchedPatterns: [],
    restoredPanels: [],
    contextKeys: {},
    errors: [],
    disposedCount: 0,
    // Replaced below, once the Uri class and the emitter it needs exist.
    setWorkspaceFolders: () => {}
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

  interface ConfigurationChangeEvent {
    affectsConfiguration(section: string): boolean;
  }

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

  const configurationChanged = new EventEmitter<ConfigurationChangeEvent>();
  const workspaceFoldersChanged = new EventEmitter<void>();

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

  /**
   * A webview panel as the host hands one back for restore.
   *
   * Reports itself hidden, which is what a restored-but-not-focused panel is, so the
   * payload push short-circuits and no message plumbing is needed here.
   */
  function makeWebviewPanel() {
    const record = { disposed: false, title: '' };
    state.restoredPanels.push(record);

    return {
      viewType: 'gitray.radar',
      visible: false,
      active: false,
      iconPath: undefined as unknown,
      get title() {
        return record.title;
      },
      set title(value: string) {
        record.title = value;
      },
      webview: {
        html: '',
        cspSource: 'vscode-webview:',
        asWebviewUri: (uri: unknown) => uri,
        postMessage: async () => true,
        onDidReceiveMessage: () => new Disposable()
      },
      onDidDispose: () => new Disposable(),
      reveal: () => {},
      dispose: () => {
        record.disposed = true;
        state.disposedCount++;
      }
    };
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
        const record: StatusBarRecord = {
          text: '',
          tooltipHistory: [],
          disposed: false,
          visible: false
        };
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
          show: () => {
            record.visible = true;
          },
          hide: () => {
            record.visible = false;
          },
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

      /**
       * Registering a serializer immediately hands back the panels to restore.
       *
       * This is the timing that matters, and it is why it is modelled rather than stubbed
       * out: the real host calls the deserializer as soon as the serializer is registered,
       * which is *before* activation has finished discovering repositories. A serializer
       * that decides anything from the session list at that moment finds it empty.
       */
      registerWebviewPanelSerializer: (
        _viewType: string,
        serializer?: { deserializeWebviewPanel(panel: unknown, state: unknown): unknown }
      ) => {
        if (serializer) void serializer.deserializeWebviewPanel(makeWebviewPanel(), undefined);
        return new Disposable();
      },
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
      workspaceFolders: roots.map((root, index) => ({
        uri: Uri.file(root),
        name: basename(root),
        index
      })),
      textDocuments: [] as unknown[],

      /**
       * Settings, with folder overrides where a scope asks for them.
       *
       * Faithful on the one point that matters for multi-root: a value written for a
       * folder is visible to that folder and to nobody else. A stub that ignored the
       * scope would let a mute leak across repositories and call the test green.
       */
      getConfiguration: (section: string, scope?: { fsPath?: string }) => {
        const folder = scope?.fsPath;
        const id = (key: string) => (section ? `${section}.${key}` : key);

        return {
          get: (key: string, fallback?: unknown) => {
            const full = id(key);
            const scoped = folder ? state.folderSettings[folder]?.[full] : undefined;
            if (scoped !== undefined) return scoped;
            if (full in state.settings) return state.settings[full];
            return full in settingDefaults ? settingDefaults[full] : fallback;
          },
          // Writes are real, and they announce themselves. A no-op `update` would let a
          // command claim to have muted something while every later `get` said otherwise.
          update: async (key: string, value: unknown, target?: number) => {
            const full = id(key);
            if (target === 3 && folder) {
              state.folderSettings[folder] ??= {};
              state.folderSettings[folder][full] = value;
            } else {
              state.settings[full] = value;
            }
            configurationChanged.fire({
              affectsConfiguration: (queried: string) =>
                full === queried || full.startsWith(`${queried}.`)
            });
          }
        };
      },

      createFileSystemWatcher: (pattern: { base?: { fsPath?: string }; pattern?: string }) => {
        const record = {
          base: pattern?.base?.fsPath ?? '',
          pattern: pattern?.pattern ?? '',
          disposed: false
        };
        state.watchedPatterns.push(record);
        return {
          onDidChange: () => new Disposable(),
          onDidCreate: () => new Disposable(),
          onDidDelete: () => new Disposable(),
          dispose: () => {
            record.disposed = true;
            state.disposedCount++;
          }
        };
      },

      registerTextDocumentContentProvider: (scheme: string) => {
        state.contentProviderSchemes.push(scheme);
        return new Disposable();
      },

      onDidSaveTextDocument: () => new Disposable(),
      onDidChangeTextDocument: () => new Disposable(),
      onDidCloseTextDocument: () => new Disposable(),
      onDidChangeConfiguration: (listener: (event: ConfigurationChangeEvent) => void) =>
        configurationChanged.event(listener),
      onDidChangeWorkspaceFolders: (listener: () => void) =>
        workspaceFoldersChanged.event(listener),

      openTextDocument: async () => ({ getText: () => '', version: 1, lineCount: 0 }),

      fs: {
        readFile: async (uri: { fsPath: string }) => new Uint8Array(await readFile(uri.fsPath)),
        stat: async (uri: { fsPath: string }) => ({ mtime: statSync(uri.fsPath).mtimeMs })
      }
    },

    commands: {
      registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
        state.registeredCommands.set(name, handler);
        return new Disposable(() => state.registeredCommands.delete(name));
      },
      executeCommand: async (command: string, ...args: unknown[]) => {
        // `setContext` is how the sidebar chooses its welcome content, so what it publishes
        // is observable behaviour rather than an implementation detail.
        if (command === 'setContext' && typeof args[0] === 'string') {
          state.contextKeys[args[0]] = args[1];
        }
        return undefined;
      }
    },

    env: {
      openExternal: async () => true
    },

    // No session by default, which is what a machine that has never signed in looks like.
    // Tests that want the API transport seed `stub.githubSession`.
    authentication: {
      getSession: async (
        providerId: string,
        scopes: string[],
        options?: { createIfNone?: boolean; silent?: boolean }
      ) => {
        const interactive = options?.createIfNone === true;
        state.sessionRequests.push({ providerId, scopes, interactive });
        if (state.githubSession) return state.githubSession;
        // Faithful to the real provider: a silent request with no session returns nothing,
        // while an interactive one the user dismisses *rejects*. Returning undefined for
        // both would leave the cancellation path looking tested when it never ran.
        if (interactive) throw new Error('User did not consent to login.');
        return undefined;
      },
      onDidChangeSessions: () => new Disposable()
    },

    languages: {
      registerHoverProvider: noopDisposable
    }
  };

  state.api = api as unknown as Record<string, unknown>;
  state.setWorkspaceFolders = (next: string[]) => {
    api.workspace.workspaceFolders = next.map((root, index) => ({
      uri: Uri.file(root),
      name: basename(root),
      index
    }));
    workspaceFoldersChanged.fire();
  };
  state.context = {
    subscriptions: [] as { dispose(): unknown }[],
    extensionUri: Uri.file(projectRoot)
  };

  return state;
}

/**
 * Activation and wiring.
 *
 * GitRay attaches to the first workspace folder that is a git repository and builds one
 * stack of components for it. Everything is created here and disposed together, so
 * closing the folder or reloading the window leaves nothing running.
 */

import * as vscode from 'vscode';
import { initLog, log } from './core/log.js';
import { readConfig } from './core/config.js';
import { Store } from './model/store.js';
import { Analyzer } from './model/analyzer.js';
import { Repository } from './providers/repository.js';
import { SyncEngine } from './sync/engine.js';
import { Scheduler } from './sync/scheduler.js';
import { CollisionScanner } from './sync/scanner.js';
import { EditorController } from './ui/editorController.js';
import { PulseTreeProvider } from './ui/tree.js';
import { GitRayFileDecorationProvider } from './ui/fileDecorations.js';
import { StatusBar } from './ui/statusBar.js';
import { PullRequestContentProvider } from './ui/contentProvider.js';
import { registerCommands } from './ui/commands.js';
import { openWorkspaceFile } from './ui/open.js';
import { RadarPanel } from './radar/panel.js';

let active: vscode.Disposable | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(initLog());
  log.info('GitRay activating');

  const attach = async () => {
    active?.dispose();
    active = await build(context);
    if (active) context.subscriptions.push(active);
  };

  await attach();

  // Adding or removing a folder can change whether there is a repository to attach to.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void attach()),
    new vscode.Disposable(() => {
      active?.dispose();
      active = undefined;
    })
  );
}

export function deactivate(): void {
  active?.dispose();
  active = undefined;
}

async function build(context: vscode.ExtensionContext): Promise<vscode.Disposable | undefined> {
  const repository = await findRepository();
  if (!repository) {
    log.info('no git repository in this workspace; GitRay is idle');
    // Nothing else runs in this case, so the view's welcome content is the only place
    // left to say why. PulseTreeProvider owns this key whenever there is a repository.
    void vscode.commands.executeCommand('setContext', 'gitray.view', 'noRepo');
    return undefined;
  }

  log.info(`attached to ${repository.root}`);

  const store = new Store();
  const analyzer = new Analyzer(repository.git, store, repository.remotes);
  const engine = new SyncEngine(repository, store, analyzer);
  const scanner = new CollisionScanner(repository, store, analyzer);
  const scheduler = new Scheduler(engine, repository);
  const controller = new EditorController(repository, store, analyzer);
  const tree = new PulseTreeProvider(repository, store, scanner);
  const fileDecorations = new GitRayFileDecorationProvider(repository, store, scanner);
  const statusBar = new StatusBar(store, scanner);
  const contentProvider = new PullRequestContentProvider(repository);

  const treeView = vscode.window.createTreeView('gitray.pulse', {
    treeDataProvider: tree,
    showCollapseAll: true
  });

  const commands = registerCommands({
    extensionUri: context.extensionUri,
    repository,
    store,
    scanner,
    controller,
    scheduler,
    engine
  });

  const serializer = vscode.window.registerWebviewPanelSerializer(RadarPanel.viewType, {
    async deserializeWebviewPanel(panel) {
      RadarPanel.restore(panel, context.extensionUri, store, scanner, (path, line) =>
        void openWorkspaceFile(repository, path, line)
      );
    }
  });

  // A sync brings new pull request data; the scan turns it into collisions against the
  // work you have in progress. Keeping them in this order means the tree and status bar
  // never show pull requests without their collision state catching up a moment later.
  const rescan = store.onDidChange(() => {
    void scanner.scan(readConfig(repository.folder.uri));
  });

  // Saving can resolve or create a collision in a file that is not open, so the scan has
  // to run on save too, not just on sync.
  const rescanOnSave = vscode.workspace.onDidSaveTextDocument((document) => {
    if (repository.relativePath(document.uri)) {
      analyzer.invalidate(repository.relativePath(document.uri) as string);
      void scanner.scan(readConfig(repository.folder.uri));
    }
  });

  const collisionContext = scanner.onDidChange(() => {
    void vscode.commands.executeCommand(
      'setContext',
      'gitray.hasCollisions',
      scanner.collisionCount() > 0
    );
  });

  scheduler.start();

  return vscode.Disposable.from(
    { dispose: () => log.info('GitRay detaching') },
    scheduler,
    controller,
    scanner,
    tree,
    treeView,
    fileDecorations,
    statusBar,
    contentProvider,
    serializer,
    rescan,
    rescanOnSave,
    collisionContext,
    ...commands,
    store
  );
}

/** First workspace folder backed by a git repository. */
async function findRepository(): Promise<Repository | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const repository = await Repository.discover(folder);
    if (repository) return repository;
  }
  return undefined;
}

/**
 * Activation and wiring.
 *
 * GitRay attaches to every workspace folder backed by a git repository and gives each one
 * its own session — its own store, poll loop, and collision scan. The surfaces the editor
 * only lets an extension register once are built once, here, and read across all of them.
 *
 * Everything is created together and disposed together, so closing a folder or reloading
 * the window leaves nothing running.
 */

import * as vscode from 'vscode';
import { initLog, log } from './core/log.js';
import { Workspace } from './workspace.js';
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

  const workspace = new Workspace();
  active = build(context, workspace);
  context.subscriptions.push(active, {
    dispose: () => {
      active = undefined;
    }
  });

  // Adding or removing a folder changes which repositories there are to attach to. The
  // surfaces above stay put; only the session set is reconciled.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void workspace.refresh())
  );

  await workspace.refresh();
}

export function deactivate(): void {
  active?.dispose();
  active = undefined;
}

function build(context: vscode.ExtensionContext, workspace: Workspace): vscode.Disposable {
  const tree = new PulseTreeProvider(workspace);
  const fileDecorations = new GitRayFileDecorationProvider(workspace);
  const statusBar = new StatusBar(workspace);
  const contentProvider = new PullRequestContentProvider(workspace);

  const treeView = vscode.window.createTreeView('gitray.pulse', {
    treeDataProvider: tree,
    showCollapseAll: true
  });

  const commands = registerCommands({ extensionUri: context.extensionUri, workspace });

  const serializer = vscode.window.registerWebviewPanelSerializer(RadarPanel.viewType, {
    async deserializeWebviewPanel(panel) {
      // VS Code restores panels as soon as the serializer is registered, which is before
      // the first discovery pass has spawned its first git process. Deciding anything from
      // the session list at that moment would find it empty and throw the panel away on
      // every reload — including in single-repository windows, where restore used to work.
      await workspace.whenReady();

      // A restored panel predates this window's session set, so it lands on whichever
      // repository is in front of you now. There is nothing to restore it from otherwise —
      // the folder list may well have changed between sessions.
      //
      // Falling back to the first repository rather than giving up: `active()` is undefined
      // with several attached and no file focused, which is exactly the state a window is in
      // while it is still restoring. Discarding the tab there would be the worst answer, and
      // there is nobody to ask — the panel repaints from live data and retargets the moment
      // Open Radar is used, so a first guess costs nothing.
      const session = workspace.active() ?? workspace.all()[0];
      if (!session) {
        panel.dispose();
        return;
      }
      RadarPanel.restore(panel, context.extensionUri, session, workspace.size > 1, (path, line) =>
        void openWorkspaceFile(session.repository, path, line)
      );
    }
  });

  const collisionContext = workspace.onDidChange(() => {
    void vscode.commands.executeCommand(
      'setContext',
      'gitray.hasCollisions',
      workspace.collisionCount() > 0
    );
  });

  return vscode.Disposable.from(
    { dispose: () => log.info('GitRay detaching') },
    tree,
    treeView,
    fileDecorations,
    statusBar,
    contentProvider,
    serializer,
    collisionContext,
    ...commands,
    // Last: the sessions own the stores every surface above reads from.
    workspace
  );
}

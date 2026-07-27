/**
 * Command surface.
 *
 * Commands are invoked from four places — the palette, tree context menus, hover card
 * links, and the radar — so every handler accepts a loosely-typed argument object and
 * falls back to the active editor when it is called without one.
 */

import * as vscode from 'vscode';
import { log } from '../core/log.js';
import { readConfig, updateSetting } from '../core/config.js';
import type { Store } from '../model/store.js';
import type { Repository } from '../providers/repository.js';
import type { Scheduler } from '../sync/scheduler.js';
import type { SyncEngine } from '../sync/engine.js';
import type { CollisionScanner } from '../sync/scanner.js';
import type { EditorController } from './editorController.js';
import { pullRequestFileUri } from './contentProvider.js';
import { openWorkspaceFile } from './open.js';
import { RadarPanel } from '../radar/panel.js';
import { pickFixture } from '../dev/fixtures.js';
import type { ResolvedRegion } from '../core/types.js';

interface CommandArgs {
  prNumber?: number;
  path?: string;
  line?: number;
}

export interface CommandContext {
  extensionUri: vscode.Uri;
  repository: Repository;
  store: Store;
  scanner: CollisionScanner;
  controller: EditorController;
  scheduler: Scheduler;
  engine: SyncEngine;
}

export function registerCommands(context: CommandContext): vscode.Disposable[] {
  const { repository, store, scanner, controller, scheduler, engine, extensionUri } = context;

  const openFile = (path: string, line?: number): Promise<void> =>
    openWorkspaceFile(repository, path, line);

  /** Resolve which pull request and path a command is about. */
  const resolve = (args?: CommandArgs): { prNumber?: number; path?: string } => {
    const editor = vscode.window.activeTextEditor;
    const activePath = editor ? repository.relativePath(editor.document.uri) : undefined;
    return {
      prNumber: args?.prNumber,
      path: args?.path ?? activePath
    };
  };

  return [
    vscode.commands.registerCommand('gitray.refresh', async () => {
      await scheduler.request('manual');
      await scanner.scan(readConfig(repository.folder.uri));
      controller.refreshVisible();
    }),

    vscode.commands.registerCommand('gitray.showOutput', () => log.show()),

    vscode.commands.registerCommand('gitray.toggleDecorations', async () => {
      const current = readConfig(repository.folder.uri).decorationMode;
      // Cycle through the three modes rather than a binary toggle, so "quiet but still
      // warn me" is reachable without opening settings.
      const next =
        current === 'ambient' ? 'collisionsOnly' : current === 'collisionsOnly' ? 'off' : 'ambient';
      await updateSetting('decorations.mode', next);
      controller.refreshVisible();
      void vscode.window.setStatusBarMessage(`GitRay indicators: ${describeMode(next)}`, 2500);
    }),

    vscode.commands.registerCommand('gitray.openRadar', () => {
      RadarPanel.show(extensionUri, store, scanner, (path, line) => void openFile(path, line));
    }),

    vscode.commands.registerCommand('gitray.revealRegion', async (args?: CommandArgs) => {
      if (args?.path) await openFile(args.path, args.line);
    }),

    vscode.commands.registerCommand('gitray.openPullRequest', async (args?: CommandArgs) => {
      const prNumber = args?.prNumber ?? (await promptForPullRequest(store));
      if (prNumber === undefined) return;

      const pr = store.pullRequest(prNumber);
      if (pr?.url) {
        await vscode.env.openExternal(vscode.Uri.parse(pr.url));
        return;
      }
      await repository.gh.openInBrowser(prNumber);
    }),

    vscode.commands.registerCommand('gitray.diffWithPullRequest', async (args?: CommandArgs) => {
      const { path } = resolve(args);
      if (!path) {
        void vscode.window.showInformationMessage('GitRay: open a file to compare it.');
        return;
      }

      const prNumber = args?.prNumber ?? (await promptForPullRequestTouching(store, path));
      if (prNumber === undefined) return;

      const pr = store.pullRequest(prNumber);
      const title = `${basename(path)} — yours ↔ #${prNumber} ${pr?.author ?? ''}`.trim();

      await vscode.commands.executeCommand(
        'vscode.diff',
        repository.uriFor(path),
        pullRequestFileUri(prNumber, path),
        title,
        { preview: true }
      );
    }),

    vscode.commands.registerCommand('gitray.checkoutPullRequest', async (args?: CommandArgs) => {
      const prNumber = args?.prNumber ?? (await promptForPullRequest(store));
      if (prNumber === undefined) return;

      const pr = store.pullRequest(prNumber);
      if (!pr) return;

      if (!(await repository.git.isClean())) {
        const choice = await vscode.window.showWarningMessage(
          `You have uncommitted changes. Check out \`${pr.headRefName}\` anyway?`,
          { modal: true },
          'Check out'
        );
        if (choice !== 'Check out') return;
      }

      try {
        // Via gh rather than raw git: fork heads have no branch on `origin` to fetch.
        await repository.gh.checkout(pr.number);
        void vscode.window.showInformationMessage(`GitRay: checked out \`${pr.headRefName}\`.`);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `GitRay: could not check out \`${pr.headRefName}\` — ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }),

    vscode.commands.registerCommand('gitray.mutePullRequest', async (args?: CommandArgs) => {
      const prNumber = args?.prNumber ?? (await promptForPullRequest(store));
      if (prNumber === undefined) return;

      const muted = readConfig(repository.folder.uri).mutedPullRequests;
      if (!muted.includes(prNumber)) {
        await updateSetting('mutedPullRequests', [...muted, prNumber]);
      }
      await scheduler.request('manual');
    }),

    vscode.commands.registerCommand('gitray.unmuteAll', async () => {
      await updateSetting('mutedPullRequests', []);
      await updateSetting('mutedAuthors', []);
      await scheduler.request('manual');
    }),

    vscode.commands.registerCommand('gitray.nextCollision', () => {
      void jumpToCollision(controller, scanner, repository, openFile, 'next');
    }),

    vscode.commands.registerCommand('gitray.previousCollision', () => {
      void jumpToCollision(controller, scanner, repository, openFile, 'previous');
    }),

    vscode.commands.registerCommand('gitray.removeRefs', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Remove every local refs/gitray/* ref? GitRay will re-fetch what it needs on the next sync.',
        { modal: true },
        'Remove'
      );
      if (choice !== 'Remove') return;

      const removed = await repository.git.deleteAllRefs();
      void vscode.window.showInformationMessage(
        `GitRay: removed ${removed} ${removed === 1 ? 'ref' : 'refs'}.`
      );
    }),

    vscode.commands.registerCommand('gitray.loadFixture', async () => {
      const fixture = await pickFixture();
      if (!fixture) return;

      engine.useFixture(fixture);
      await scheduler.request('manual');
      void vscode.window.showInformationMessage(
        `GitRay: loaded ${fixture.length} fixture pull ${fixture.length === 1 ? 'request' : 'requests'}.`
      );
    }),

    vscode.commands.registerCommand('gitray.clearFixture', async () => {
      engine.useFixture(undefined);
      store.clear();
      await scheduler.request('manual');
    })
  ];
}

/**
 * Move between collisions.
 *
 * Searches the current file first and wraps to other affected files when there is
 * nothing left here, so repeated presses walk the whole branch's worth of conflicts
 * rather than dead-ending in one document.
 */
async function jumpToCollision(
  controller: EditorController,
  scanner: CollisionScanner,
  repository: Repository,
  openFile: (path: string, line?: number) => Promise<void>,
  direction: 'next' | 'previous'
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const currentPath = editor ? repository.relativePath(editor.document.uri) : undefined;

  if (editor && currentPath) {
    const analysis = controller.analysisFor(editor.document.uri) ?? scanner.analysisFor(currentPath);
    const collisions = (analysis?.regions ?? []).filter((r) => r.severity === 'collision');
    const target = pickRelative(collisions, editor.selection.active.line, direction);

    if (target) {
      const range = new vscode.Range(target.range.start, 0, target.range.start, 0);
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
  }

  const files = scanner.hotFiles().filter((analysis) =>
    analysis.regions.some((region) => region.severity === 'collision')
  );
  if (files.length === 0) {
    void vscode.window.setStatusBarMessage('GitRay: no collisions with your current work.', 2500);
    return;
  }

  // From a file outside the list there is no "adjacent" file, so enter the cycle at the
  // appropriate end; from inside it, step around it with wraparound.
  const currentIndex = files.findIndex((analysis) => analysis.path === currentPath);
  const step = direction === 'next' ? 1 : -1;
  const nextIndex =
    currentIndex === -1
      ? direction === 'next'
        ? 0
        : files.length - 1
      : (currentIndex + step + files.length) % files.length;
  const nextFile = files[nextIndex];

  const collisions = nextFile.regions.filter((r) => r.severity === 'collision');
  const target = direction === 'next' ? collisions[0] : collisions[collisions.length - 1];
  await openFile(nextFile.path, target?.range.start);
}

function pickRelative(
  regions: readonly ResolvedRegion[],
  line: number,
  direction: 'next' | 'previous'
): ResolvedRegion | undefined {
  const sorted = [...regions].sort((a, b) => a.range.start - b.range.start);
  return direction === 'next'
    ? sorted.find((region) => region.range.start > line)
    : [...sorted].reverse().find((region) => region.range.start < line);
}

async function promptForPullRequest(store: Store): Promise<number | undefined> {
  const items = store.allPullRequests().map((pr) => ({
    label: `#${pr.number} ${pr.title}`,
    description: pr.author,
    detail: pr.headRefName,
    prNumber: pr.number
  }));

  if (items.length === 0) {
    void vscode.window.showInformationMessage('GitRay: no open pull requests are being tracked.');
    return undefined;
  }
  if (items.length === 1) return items[0].prNumber;

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a pull request'
  });
  return picked?.prNumber;
}

async function promptForPullRequestTouching(
  store: Store,
  path: string
): Promise<number | undefined> {
  const candidates = store.pullRequestsForPath(path);
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(
      'GitRay: no tracked pull request changes this file.'
    );
    return undefined;
  }
  if (candidates.length === 1) return candidates[0].number;

  const picked = await vscode.window.showQuickPick(
    candidates.map((pr) => ({
      label: `#${pr.number} ${pr.title}`,
      description: pr.author,
      prNumber: pr.number
    })),
    { placeHolder: `Compare ${basename(path)} against which pull request?` }
  );
  return picked?.prNumber;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function describeMode(mode: string): string {
  switch (mode) {
    case 'ambient':
      return 'all collaborator changes';
    case 'collisionsOnly':
      return 'collisions only';
    default:
      return 'off';
  }
}

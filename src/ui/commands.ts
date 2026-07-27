/**
 * Command surface.
 *
 * Commands are invoked from four places — the palette, tree context menus, hover card
 * links, and the radar — so every handler accepts a loosely-typed argument object and
 * falls back to the active editor when it is called without one.
 */

import * as vscode from 'vscode';
import { log } from '../core/log.js';
import { isMutedAuthor, readConfig, updateSetting } from '../core/config.js';
import type { Store } from '../model/store.js';
import type { Repository } from '../providers/repository.js';
import { signIn } from '../providers/session.js';
import type { Scheduler } from '../sync/scheduler.js';
import type { SyncEngine } from '../sync/engine.js';
import type { CollisionScanner } from '../sync/scanner.js';
import type { EditorController } from './editorController.js';
import { mainlineFileUri, pullRequestFileUri } from './contentProvider.js';
import { openWorkspaceFile } from './open.js';
import { RadarPanel } from '../radar/panel.js';
import { pickFixture } from '../dev/fixtures.js';
import type { ResolvedRegion } from '../core/types.js';

interface CommandArgs {
  prNumber?: number;
  path?: string;
  line?: number;
  author?: string;
}

/**
 * Make sense of whatever the caller passed.
 *
 * The palette passes nothing, hover links pass an explicit object, and a context menu
 * passes the tree node itself — which is a different shape entirely. Reading both here is
 * what makes "Mute" on a row act on *that* row; before this, every context-menu invocation
 * arrived with no recognisable argument and fell through to a quick pick asking which pull
 * request you meant, having just been told.
 */
function toArgs(raw: unknown): CommandArgs {
  if (typeof raw !== 'object' || raw === null) return {};

  const node = raw as {
    prNumber?: unknown;
    path?: unknown;
    line?: unknown;
    author?: unknown;
    pr?: { number?: unknown; author?: unknown };
  };

  return {
    prNumber: asNumber(node.prNumber ?? node.pr?.number),
    path: asString(node.path),
    line: asNumber(node.line),
    author: asString(node.author ?? node.pr?.author)
  };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
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
  const resolve = (raw?: unknown): CommandArgs => {
    const args = toArgs(raw);
    const editor = vscode.window.activeTextEditor;
    const activePath = editor ? repository.relativePath(editor.document.uri) : undefined;
    return { ...args, path: args.path ?? activePath };
  };

  const say = (message: string): void => {
    void vscode.window.setStatusBarMessage(`GitRay: ${message}`, 2500);
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

    vscode.commands.registerCommand('gitray.revealRegion', async (raw?: unknown) => {
      const args = toArgs(raw);
      if (args.path) await openFile(args.path, args.line);
    }),

    vscode.commands.registerCommand('gitray.openPullRequest', async (raw?: unknown) => {
      const prNumber = toArgs(raw).prNumber ?? (await promptForPullRequest(store));
      if (prNumber === undefined) return;

      // Muted pull requests are openable too — that is how you decide whether to unmute
      // one — and their record still carries the url, so this need not shell out to gh.
      const pr = store.pullRequest(prNumber) ?? store.mutedPullRequest(prNumber);
      const url = pr?.url || repository.github.pullRequestUrl(prNumber);
      if (url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      // Nothing local knows where this one lives; gh can look it up.
      await repository.github.openInBrowser(prNumber);
    }),

    /**
     * Sign in with the editor's own GitHub account.
     *
     * The one place GitRay is allowed to open an authentication dialog, and it takes an
     * explicit click on the sidebar's signed-out row to get here. Polling never asks.
     */
    vscode.commands.registerCommand('gitray.signIn', async () => {
      if (!(await signIn())) return;
      // The engine re-probes on every pass while it is degraded, so this only brings the
      // answer forward — but waiting a minute after signing in reads like nothing happened.
      await scheduler.request('manual');
      await scanner.scan(readConfig(repository.folder.uri));
      controller.refreshVisible();
    }),

    vscode.commands.registerCommand('gitray.diffWithPullRequest', async (raw?: unknown) => {
      const { path, prNumber: requested } = resolve(raw);
      if (!path) {
        void vscode.window.showInformationMessage('GitRay: open a file to compare it.');
        return;
      }

      const prNumber = requested ?? (await promptForPullRequestTouching(store, path));
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

    /**
     * Diff a file against the mainline's copy of it.
     *
     * Pinned to the tip GitRay analyzed, not to `origin/<branch>`: the indicators and the
     * diff have to agree about which commit "the mainline" means, or the diff will show
     * changes the marks never predicted.
     */
    vscode.commands.registerCommand('gitray.diffWithMainline', async (raw?: unknown) => {
      const { path } = resolve(raw);
      if (!path) {
        void vscode.window.showInformationMessage('GitRay: open a file to compare it.');
        return;
      }

      const mainline = store.mainline();
      if (!mainline) {
        void vscode.window.showInformationMessage(
          'GitRay: the mainline has not been read yet. Try refreshing.'
        );
        return;
      }

      await vscode.commands.executeCommand(
        'vscode.diff',
        repository.uriFor(path),
        mainlineFileUri(mainline.tip, path),
        `${basename(path)} — yours ↔ ${mainline.branch}`,
        { preview: true }
      );
    }),

    vscode.commands.registerCommand('gitray.checkoutPullRequest', async (raw?: unknown) => {
      const prNumber = toArgs(raw).prNumber ?? (await promptForPullRequest(store));
      if (prNumber === undefined) return;

      const pr = store.pullRequest(prNumber);
      if (!pr) return;

      // The one thing the editor's GitHub session cannot stand in for. Checking out a fork
      // head needs a ref that does not exist on `origin`, and it needs the branch wired up
      // so a later push reaches the contributor — gh does both, and a local branch cut from
      // GitRay's read-only ref would look identical while pushing to the wrong place.
      if (!(await repository.github.canCheckout())) {
        const choice = await vscode.window.showInformationMessage(
          'GitRay: checking out a pull request branch needs the GitHub CLI (gh), installed and signed in. Everything else works without it.',
          'Open on GitHub'
        );
        if (choice === 'Open on GitHub') {
          await vscode.commands.executeCommand('gitray.openPullRequest', { prNumber });
        }
        return;
      }

      if (!(await repository.git.isClean())) {
        const choice = await vscode.window.showWarningMessage(
          `You have uncommitted changes. Check out \`${pr.headRefName}\` anyway?`,
          { modal: true },
          'Check out'
        );
        if (choice !== 'Check out') return;
      }

      try {
        await repository.github.checkout(pr.number);
        void vscode.window.showInformationMessage(`GitRay: checked out \`${pr.headRefName}\`.`);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `GitRay: could not check out \`${pr.headRefName}\` — ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }),

    /*
     * Muting and unmuting.
     *
     * Every one of these is reachable three ways — the palette, a context menu on the row
     * it is about, and (for pull requests) the hover card — and every one of them ends in
     * the Muted section of the sidebar, which is where the decision can be seen and taken
     * back. A mute you cannot find again is a mute you cannot undo.
     */
    vscode.commands.registerCommand('gitray.mutePullRequest', async (raw?: unknown) => {
      const prNumber = toArgs(raw).prNumber ?? (await promptForPullRequest(store));
      if (prNumber === undefined) return;

      const muted = readConfig(repository.folder.uri).mutedPullRequests;
      if (!muted.includes(prNumber)) {
        await updateSetting('mutedPullRequests', [...muted, prNumber]);
      }
      await scheduler.request('manual');
      say(`muted #${prNumber}. Unmute it under Muted in the sidebar.`);
    }),

    vscode.commands.registerCommand('gitray.muteAuthor', async (raw?: unknown) => {
      const author = toArgs(raw).author ?? (await promptForAuthor(store));
      if (author === undefined) return;

      const config = readConfig(repository.folder.uri);
      // Stored as GitHub spelled it, matched case-insensitively. The list is meant to be
      // readable by whoever opens settings.json next.
      if (!isMutedAuthor(config, author)) {
        await updateSetting('mutedAuthors', [...config.mutedAuthors, author]);
      }
      await scheduler.request('manual');
      say(`muted ${author}. Unmute them under Muted in the sidebar.`);
    }),

    vscode.commands.registerCommand('gitray.unmutePullRequest', async (raw?: unknown) => {
      const muted = readConfig(repository.folder.uri).mutedPullRequests;
      const prNumber = toArgs(raw).prNumber ?? (await promptForMutedPullRequest(store, muted));
      if (prNumber === undefined) return;

      await updateSetting(
        'mutedPullRequests',
        muted.filter((number) => number !== prNumber)
      );
      await scheduler.request('manual');
      say(`unmuted #${prNumber}.`);
    }),

    vscode.commands.registerCommand('gitray.unmuteAuthor', async (raw?: unknown) => {
      const muted = readConfig(repository.folder.uri).mutedAuthors;
      const author = toArgs(raw).author ?? (await promptForMutedAuthor(store, muted));
      if (author === undefined) return;

      await updateSetting(
        'mutedAuthors',
        muted.filter((candidate) => candidate.toLowerCase() !== author.toLowerCase())
      );
      await scheduler.request('manual');
      say(`unmuted ${author}.`);
    }),

    vscode.commands.registerCommand('gitray.unmuteAll', async () => {
      const config = readConfig(repository.folder.uri);
      const count = config.mutedPullRequests.length + config.mutedAuthors.length;
      if (count === 0) {
        say('nothing is muted.');
        return;
      }

      await updateSetting('mutedPullRequests', []);
      await updateSetting('mutedAuthors', []);
      await scheduler.request('manual');
      say(`unmuted ${count} ${count === 1 ? 'entry' : 'entries'}.`);
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

/** Who has something open right now, most active first. */
async function promptForAuthor(store: Store): Promise<string | undefined> {
  const counts = new Map<string, number>();
  for (const pr of store.allPullRequests()) {
    counts.set(pr.author, (counts.get(pr.author) ?? 0) + 1);
  }

  if (counts.size === 0) {
    void vscode.window.showInformationMessage(
      'GitRay: no open pull requests are being tracked, so there is nobody to mute.'
    );
    return undefined;
  }

  const items = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([author, count]) => ({
      label: author,
      description: `${count} open pull ${count === 1 ? 'request' : 'requests'}`,
      author
    }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Hide this person\'s open pull requests'
  });
  return picked?.author;
}

/**
 * Which muted pull request to restore.
 *
 * Driven by the setting, not by the store: a number stays muted after its pull request
 * merges, and that stale entry is exactly the one worth being able to clear.
 */
async function promptForMutedPullRequest(
  store: Store,
  muted: readonly number[]
): Promise<number | undefined> {
  if (muted.length === 0) {
    void vscode.window.showInformationMessage('GitRay: no pull requests are muted.');
    return undefined;
  }

  const items = muted.map((prNumber) => {
    const pr = store.mutedPullRequest(prNumber);
    return {
      label: pr ? `#${prNumber} ${pr.title}` : `#${prNumber}`,
      description: pr?.author ?? 'not in the open list',
      prNumber
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Show this pull request again'
  });
  return picked?.prNumber;
}

async function promptForMutedAuthor(
  store: Store,
  muted: readonly string[]
): Promise<string | undefined> {
  if (muted.length === 0) {
    void vscode.window.showInformationMessage('GitRay: no authors are muted.');
    return undefined;
  }

  const items = muted.map((author) => {
    const hiding = store.mutedPullRequestsBy(author).length;
    return {
      label: author,
      description:
        hiding > 0
          ? `${hiding} open pull ${hiding === 1 ? 'request' : 'requests'}`
          : 'nothing open right now',
      author
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Show this person\'s pull requests again'
  });
  return picked?.author;
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

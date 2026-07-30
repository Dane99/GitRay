/**
 * Command surface.
 *
 * Commands are invoked from four places — the palette, tree context menus, hover card
 * links, and the radar — so every handler accepts a loosely-typed argument object and
 * falls back to the active editor when it is called without one.
 *
 * With several repositories open, "which one?" comes before every other question a handler
 * asks. A tree row carries its session, a hover link and a diff URI carry their repository
 * root, and everything else is answered by whichever repository the active editor is in —
 * which is what makes a hover card's links act on the file the card is attached to. Only
 * when none of those answers does a handler ask.
 */

import * as vscode from 'vscode';
import { log } from '../core/log.js';
import { isMutedAuthor, readConfig, updateSetting } from '../core/config.js';
import type { Store } from '../model/store.js';
import { prRef } from '../providers/git.js';
import { pullRequestFileUrl } from '../providers/githubUrls.js';
import { describeUnusableRemote } from '../providers/remoteSelection.js';
import { signIn } from '../providers/session.js';
import type { RepositorySession } from '../session.js';
import type { Workspace } from '../workspace.js';
import { baseFileUri, mainlineFileUri, pullRequestFileUri } from './contentProvider.js';
import { openWorkspaceFile } from './open.js';
import { RadarPanel } from '../radar/panel.js';
import { pickFixture } from '../dev/fixtures.js';
import type { ResolvedRegion } from '../core/types.js';

interface CommandArgs {
  prNumber?: number;
  path?: string;
  line?: number;
  author?: string;
  /** The repository root a caller named, when it knew one. */
  root?: string;
}

/** A command's resolved target: which repository, and what in it. */
interface Target extends CommandArgs {
  session: RepositorySession;
}

/**
 * Make sense of whatever the caller passed.
 *
 * The palette passes nothing, hover links pass an explicit object, and a context menu
 * passes the tree node itself — which is a different shape entirely. Reading both here is
 * what makes "Mute" on a row act on *that* row; before this, every context-menu invocation
 * arrived with no recognisable argument and fell through to a quick pick asking which pull
 * request you meant, having just been told.
 *
 * A collision row keeps its path one level down, inside `analysis`, so it has to be read
 * too. Missing it does not fail visibly — the file commands fall back to the active editor,
 * so a menu item clicked on one row silently acts on whichever file happens to be focused.
 *
 * The repository arrives two ways for the same reason. A tree row is a live object and
 * carries its whole session; a hover link is a URL and can only carry a string, so it
 * carries the root. Both are read here rather than duck-typed at each call site.
 */
function toArgs(raw: unknown): CommandArgs {
  if (typeof raw !== 'object' || raw === null) return {};

  const node = raw as {
    prNumber?: unknown;
    path?: unknown;
    line?: unknown;
    author?: unknown;
    root?: unknown;
    pr?: { number?: unknown; author?: unknown };
    analysis?: { path?: unknown };
    session?: { repository?: { root?: unknown } };
  };

  return {
    prNumber: asNumber(node.prNumber ?? node.pr?.number),
    path: asString(node.path ?? node.analysis?.path),
    line: asNumber(node.line),
    author: asString(node.author ?? node.pr?.author),
    root: asString(node.root ?? node.session?.repository?.root)
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
  workspace: Workspace;
}

export function registerCommands(context: CommandContext): vscode.Disposable[] {
  const { workspace, extensionUri } = context;

  const say = (message: string): void => {
    void vscode.window.setStatusBarMessage(`GitRay: ${message}`, 2500);
  };

  /**
   * Which repository a command is about, asking only when nothing else answers.
   *
   * `useActiveFile` is what separates the two kinds of file command. A hover card and a
   * file row are asking about a specific file; the palette is asking about whatever you
   * are looking at. The commands that are about a *pull request* rather than a file pass
   * false, so they never silently adopt the path of an unrelated open editor.
   */
  const target = async (raw?: unknown, useActiveFile = true): Promise<Target | undefined> => {
    const args = toArgs(raw);
    const session =
      workspace.sessionAt(args.root) ??
      workspace.active() ??
      (await promptForRepository(workspace));
    if (!session) return undefined;

    if (!useActiveFile || args.path !== undefined) return { ...args, session };

    const editor = vscode.window.activeTextEditor;
    const path = editor ? session.repository.relativePath(editor.document.uri) : undefined;
    return { ...args, path, session };
  };

  /** Every repository, or the single one the caller named. */
  const targets = (raw?: unknown): readonly RepositorySession[] => {
    const named = workspace.sessionAt(toArgs(raw).root);
    return named ? [named] : workspace.all();
  };

  const openFile = (session: RepositorySession, path: string, line?: number): Promise<void> =>
    openWorkspaceFile(session.repository, path, line);

  const refreshOne = async (session: RepositorySession): Promise<void> => {
    await session.scheduler.request('manual');
    await session.scanner.scan(session.config());
    session.controller.refreshVisible();
  };

  /**
   * The commit a pull request and your branch share.
   *
   * Routed through the analyzer so this is the *same* answer the indicators were computed
   * against — asking git again would usually agree and, in the window where a fetch has
   * moved the head, quietly would not, putting a diff on screen that disagrees with the
   * marks in the gutter. The direct call is only for a pull request the store has never
   * seen, which has no cached answer to be consistent with.
   */
  const mergeBaseFor = async (
    session: RepositorySession,
    prNumber: number
  ): Promise<string | undefined> => {
    const pr = session.store.pullRequest(prNumber);
    return pr
      ? session.analyzer.mergeBaseFor(pr)
      : session.repository.git.mergeBase(prRef(prNumber));
  };

  return [
    /**
     * Refresh: the whole window from the view title or the palette, one repository when
     * the caller named one. Polling each repository separately is the point — they have
     * independent remotes, and one being unreachable must not hold up the others.
     */
    vscode.commands.registerCommand('gitray.refresh', async (raw?: unknown) => {
      await Promise.all(targets(raw).map(refreshOne));
    }),

    vscode.commands.registerCommand('gitray.showOutput', () => log.show()),

    vscode.commands.registerCommand('gitray.toggleDecorations', async () => {
      // Deliberately not per repository, and written workspace-wide: this is a statement
      // about how loud the editor should be, and gutters going quiet in one folder but not
      // the next would read as a bug rather than as a setting.
      const current = readConfig(workspace.active()?.repository.folder.uri).decorationMode;
      // Cycle through the three modes rather than a binary toggle, so "quiet but still
      // warn me" is reachable without opening settings.
      const next =
        current === 'ambient' ? 'collisionsOnly' : current === 'collisionsOnly' ? 'off' : 'ambient';
      await updateSetting('decorations.mode', next);
      for (const session of workspace.all()) session.controller.refreshVisible();
      void vscode.window.setStatusBarMessage(`GitRay indicators: ${describeMode(next)}`, 2500);
    }),

    vscode.commands.registerCommand('gitray.openRadar', async (raw?: unknown) => {
      const found = await target(raw, false);
      if (!found) return;
      const { session } = found;
      RadarPanel.show(
        extensionUri,
        session,
        workspace.size > 1,
        (path, line) => void openFile(session, path, line)
      );
    }),

    vscode.commands.registerCommand('gitray.revealRegion', async (raw?: unknown) => {
      const args = toArgs(raw);
      const session = workspace.sessionAt(args.root) ?? workspace.active();
      if (session && args.path) await openFile(session, args.path, args.line);
    }),

    /**
     * Open a pull request on GitHub, at a file when the caller named one.
     *
     * The path is taken only from what the caller passed, never from the active editor:
     * a hover card and a file row are asking about a specific file, while the palette and
     * a pull request row are asking about the pull request, and guessing the file from
     * whatever happens to be open would answer the second question with the first.
     */
    vscode.commands.registerCommand('gitray.openPullRequest', async (raw?: unknown) => {
      const found = await target(raw, false);
      if (!found) return;
      const { session, path } = found;
      const { store } = session;

      const prNumber = found.prNumber ?? (await promptForPullRequest(store));
      if (prNumber === undefined) return;

      // Muted pull requests are openable too — that is how you decide whether to unmute
      // one — and their record still carries the url.
      const pr = store.pullRequest(prNumber) ?? store.mutedPullRequest(prNumber);
      const url = pr?.url || (await session.repository.github.pullRequestUrl(prNumber));
      if (!url) {
        void vscode.window.showWarningMessage(
          `GitRay: nothing here knows which repository pull request #${prNumber} belongs to.`
        );
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(path ? pullRequestFileUrl(url, path) : url));
    }),

    /**
     * Sign in with the editor's own GitHub account.
     *
     * The one place GitRay is allowed to open an authentication dialog, and it takes an
     * explicit click on the sidebar's signed-out row to get here. Polling never asks.
     */
    vscode.commands.registerCommand('gitray.signIn', async (raw?: unknown) => {
      // Which host, because the editor holds separate sessions for github.com and for an
      // Enterprise server. The sidebar row carries the repository it belongs to, and that is
      // the only thing that answers this in a workspace holding both — the active editor
      // says which file you were reading, not which row you clicked. The palette carries
      // nothing, so it falls back to the active repository and then to github.com.
      const { root } = toArgs(raw);
      const session = (root ? workspace.sessionAt(root) : undefined) ?? workspace.active();
      const host = await session?.repository.github.host();
      if (!(await signIn(host))) return;
      // One account signs every repository in, so every one of them gets the news. The
      // engine re-probes on every pass while it is degraded, so this only brings the
      // answer forward — but waiting a minute after signing in reads like nothing happened.
      await Promise.all(workspace.all().map(refreshOne));
    }),

    vscode.commands.registerCommand('gitray.diffWithPullRequest', async (raw?: unknown) => {
      const found = await target(raw);
      if (!found) return;
      const { session, path } = found;
      const { store } = session;
      if (!path) {
        void vscode.window.showInformationMessage('GitRay: open a file to compare it.');
        return;
      }

      const prNumber = found.prNumber ?? (await promptForPullRequestTouching(store, path));
      if (prNumber === undefined) return;

      const pr = store.pullRequest(prNumber);
      const title = `${basename(path)} — yours ↔ #${prNumber} ${pr?.author ?? ''}`.trim();

      await vscode.commands.executeCommand(
        'vscode.diff',
        session.repository.uriFor(path),
        pullRequestFileUri(session.id, prNumber, path),
        title,
        { preview: true }
      );
    }),

    /**
     * Diff a pull request's change on its own, with your work left out of it.
     *
     * The companion to the command above rather than a replacement for it, because the two
     * answer different questions. Putting your working copy on the left is what shows
     * whether their edit lands on yours; putting the merge base there is what shows what
     * they actually wrote. Neither view can do both, and a diff that silently mixed the
     * answers is the thing this exists to fix.
     *
     * The price is that these are base coordinates: with edits of your own above their
     * hunk, the line numbers here match nothing you are typing into.
     */
    vscode.commands.registerCommand('gitray.diffPullRequestChange', async (raw?: unknown) => {
      const found = await target(raw);
      if (!found) return;
      const { session, path } = found;
      const { store } = session;
      if (!path) {
        void vscode.window.showInformationMessage('GitRay: open a file to compare it.');
        return;
      }

      const prNumber = found.prNumber ?? (await promptForPullRequestTouching(store, path));
      if (prNumber === undefined) return;

      const baseSha = await mergeBaseFor(session, prNumber);
      if (!baseSha) {
        // Without a shared ancestor there is no "their change alone" to show — every line
        // would differ. The working-copy diff still works, so point at it rather than
        // opening something meaningless.
        void vscode.window.showInformationMessage(
          `GitRay: no common ancestor with #${prNumber}, so their change cannot be isolated. This happens in a shallow clone or after a force push. Compare With Collaborator's Version still works.`
        );
        return;
      }

      const pr = store.pullRequest(prNumber);
      const title = `${basename(path)} — base ↔ #${prNumber} ${pr?.author ?? ''}`.trim();

      await vscode.commands.executeCommand(
        'vscode.diff',
        baseFileUri(session.id, baseSha, path),
        pullRequestFileUri(session.id, prNumber, path),
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
      const found = await target(raw);
      if (!found) return;
      const { session, path } = found;
      if (!path) {
        void vscode.window.showInformationMessage('GitRay: open a file to compare it.');
        return;
      }

      const mainline = session.store.mainline();
      if (!mainline) {
        void vscode.window.showInformationMessage(
          'GitRay: the mainline has not been read yet. Try refreshing.'
        );
        return;
      }

      await vscode.commands.executeCommand(
        'vscode.diff',
        session.repository.uriFor(path),
        mainlineFileUri(session.id, mainline.tip, path),
        `${basename(path)} — yours ↔ ${mainline.branch}`,
        { preview: true }
      );
    }),

    /**
     * Diff what landed on the mainline, with your work left out of it.
     *
     * Both ends come straight out of the recorded mainline state: `base` is where your
     * branch left, `tip` is where the branch is now, and everything between them is what
     * arrived while you were away. No merge base is computed here — the sync engine already
     * did it, and recomputing risks answering with a different commit than the indicators.
     */
    vscode.commands.registerCommand('gitray.diffMainlineChange', async (raw?: unknown) => {
      const found = await target(raw);
      if (!found) return;
      const { session, path } = found;
      if (!path) {
        void vscode.window.showInformationMessage('GitRay: open a file to compare it.');
        return;
      }

      const mainline = session.store.mainline();
      if (!mainline) {
        void vscode.window.showInformationMessage(
          'GitRay: the mainline has not been read yet. Try refreshing.'
        );
        return;
      }

      if (mainline.base === mainline.tip) {
        void vscode.window.showInformationMessage(
          `GitRay: nothing has landed on \`${mainline.branch}\` since your branch left it.`
        );
        return;
      }

      await vscode.commands.executeCommand(
        'vscode.diff',
        baseFileUri(session.id, mainline.base, path),
        mainlineFileUri(session.id, mainline.tip, path),
        `${basename(path)} — base ↔ ${mainline.branch}`,
        { preview: true }
      );
    }),

    vscode.commands.registerCommand('gitray.checkoutPullRequest', async (raw?: unknown) => {
      const found = await target(raw, false);
      if (!found) return;
      const { session } = found;
      const { store, repository } = session;

      const prNumber = found.prNumber ?? (await promptForPullRequest(store));
      if (prNumber === undefined) return;

      const pr = store.pullRequest(prNumber);
      if (!pr?.headRefName) return;

      // The head is fetched from the *base* repository even for a fork's branch, because
      // that is where GitHub publishes `refs/pull/<n>/head` — so this needs the same remote
      // everything else does, and fails as itself when there is not one.
      const remote = await repository.remotes.choose();
      if (remote.kind !== 'ok') {
        void vscode.window.showWarningMessage(`GitRay: ${describeUnusableRemote(remote)}`);
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
        await repository.git.checkoutPullRequest({
          prNumber: pr.number,
          branch: pr.headRefName,
          remote: remote.name,
          headRefName: pr.headRefName,
          isCrossRepository: pr.isCrossRepository === true,
          // Only when the pull request says maintainers may push. Wiring a branch to a fork
          // we cannot write to would turn every `git push` into a permission error, and the
          // read-only pull ref is the honest thing to track instead.
          pushUrl: pr.maintainerCanModify ? pr.headRepositoryUrl : undefined
        });
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
      const found = await target(raw, false);
      if (!found) return;
      const { session } = found;

      const prNumber = found.prNumber ?? (await promptForPullRequest(session.store));
      if (prNumber === undefined) return;

      const muted = session.config().mutedPullRequests;
      if (!muted.includes(prNumber)) {
        await updateSetting('mutedPullRequests', [...muted, prNumber], scopeOf(session));
      }
      await session.scheduler.request('manual');
      say(`muted #${prNumber}. Unmute it under Muted in the sidebar.`);
    }),

    vscode.commands.registerCommand('gitray.muteAuthor', async (raw?: unknown) => {
      const found = await target(raw, false);
      if (!found) return;
      const { session } = found;

      const author = found.author ?? (await promptForAuthor(session.store));
      if (author === undefined) return;

      const config = session.config();
      // Stored as GitHub spelled it, matched case-insensitively. The list is meant to be
      // readable by whoever opens settings.json next.
      if (!isMutedAuthor(config, author)) {
        await updateSetting('mutedAuthors', [...config.mutedAuthors, author], scopeOf(session));
      }
      await session.scheduler.request('manual');
      say(`muted ${author}. Unmute them under Muted in the sidebar.`);
    }),

    vscode.commands.registerCommand('gitray.unmutePullRequest', async (raw?: unknown) => {
      const found = await target(raw, false);
      if (!found) return;
      const { session } = found;

      const muted = session.config().mutedPullRequests;
      const prNumber = found.prNumber ?? (await promptForMutedPullRequest(session.store, muted));
      if (prNumber === undefined) return;

      await updateSetting(
        'mutedPullRequests',
        muted.filter((number) => number !== prNumber),
        scopeOf(session)
      );
      await session.scheduler.request('manual');
      say(`unmuted #${prNumber}.`);
    }),

    vscode.commands.registerCommand('gitray.unmuteAuthor', async (raw?: unknown) => {
      const found = await target(raw, false);
      if (!found) return;
      const { session } = found;

      const muted = session.config().mutedAuthors;
      const author = found.author ?? (await promptForMutedAuthor(session.store, muted));
      if (author === undefined) return;

      await updateSetting(
        'mutedAuthors',
        muted.filter((candidate) => candidate.toLowerCase() !== author.toLowerCase()),
        scopeOf(session)
      );
      await session.scheduler.request('manual');
      say(`unmuted ${author}.`);
    }),

    /**
     * Unmute everything.
     *
     * From the Muted row it clears that repository; from the view title or the palette it
     * clears the window. "All" meaning one folder of several would be the wrong reading of
     * a command whose whole promise is that nothing is left hidden.
     */
    vscode.commands.registerCommand('gitray.unmuteAll', async (raw?: unknown) => {
      const sessions = targets(raw);
      let count = 0;

      for (const session of sessions) {
        const config = session.config();
        const here = config.mutedPullRequests.length + config.mutedAuthors.length;
        if (here === 0) continue;

        await updateSetting('mutedPullRequests', [], scopeOf(session));
        await updateSetting('mutedAuthors', [], scopeOf(session));
        await session.scheduler.request('manual');
        count += here;
      }

      if (count === 0) {
        say('nothing is muted.');
        return;
      }
      say(`unmuted ${count} ${count === 1 ? 'entry' : 'entries'}.`);
    }),

    vscode.commands.registerCommand('gitray.nextCollision', () => {
      void jumpToCollision(workspace, 'next');
    }),

    vscode.commands.registerCommand('gitray.previousCollision', () => {
      void jumpToCollision(workspace, 'previous');
    }),

    vscode.commands.registerCommand('gitray.removeRefs', async (raw?: unknown) => {
      const sessions = targets(raw);
      if (sessions.length === 0) return;

      const where =
        sessions.length === 1 && workspace.size > 1 ? ` in ${sessions[0].label}` : '';
      const choice = await vscode.window.showWarningMessage(
        `Remove every local refs/gitray/* ref${where}? GitRay will re-fetch what it needs on the next sync.`,
        { modal: true },
        'Remove'
      );
      if (choice !== 'Remove') return;

      let removed = 0;
      for (const session of sessions) removed += await session.repository.git.deleteAllRefs();
      void vscode.window.showInformationMessage(
        `GitRay: removed ${removed} ${removed === 1 ? 'ref' : 'refs'}.`
      );
    }),

    vscode.commands.registerCommand('gitray.loadFixture', async (raw?: unknown) => {
      const found = await target(raw, false);
      if (!found) return;

      const fixture = await pickFixture();
      if (!fixture) return;

      found.session.engine.useFixture(fixture);
      await found.session.scheduler.request('manual');
      void vscode.window.showInformationMessage(
        `GitRay: loaded ${fixture.length} fixture pull ${fixture.length === 1 ? 'request' : 'requests'}.`
      );
    }),

    vscode.commands.registerCommand('gitray.clearFixture', async (raw?: unknown) => {
      const found = await target(raw, false);
      if (!found) return;

      found.session.engine.useFixture(undefined);
      found.session.store.clear();
      await found.session.scheduler.request('manual');
    })
  ];
}

/** Where a per-repository setting written for this session belongs. */
function scopeOf(session: RepositorySession): vscode.Uri {
  return session.repository.folder.uri;
}

/**
 * Move between collisions.
 *
 * Searches the current file first and wraps to other affected files when there is
 * nothing left here, so repeated presses walk the whole branch's worth of conflicts
 * rather than dead-ending in one document.
 *
 * Scoped to one repository, and never asks which. This is on a keybinding, and a quick
 * pick appearing under Alt+F8 would be worse than an imperfect guess: the file you are in
 * decides, and failing that the first repository that has a collision to show at all.
 */
async function jumpToCollision(
  workspace: Workspace,
  direction: 'next' | 'previous'
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const session =
    (editor ? workspace.sessionFor(editor.document.uri) : undefined) ??
    workspace.only() ??
    workspace.all().find((candidate) => candidate.scanner.collisionCount() > 0);

  if (!session) {
    void vscode.window.setStatusBarMessage('GitRay: no collisions with your current work.', 2500);
    return;
  }

  const { controller, scanner, repository } = session;
  const openFile = (path: string, line?: number) => openWorkspaceFile(repository, path, line);
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

/**
 * Which repository, when nothing in the invocation says.
 *
 * Only reachable with several attached and no relevant editor focused — a palette
 * invocation from a settings tab, say. The root is the description because two folders
 * checked out from the same project routinely share a name.
 */
async function promptForRepository(workspace: Workspace): Promise<RepositorySession | undefined> {
  const sessions = workspace.all();
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage(
      'GitRay: no git repository is open in this window.'
    );
    return undefined;
  }
  if (sessions.length === 1) return sessions[0];

  const picked = await vscode.window.showQuickPick(
    sessions.map((session) => ({
      label: session.label,
      description: session.repository.root,
      session
    })),
    { placeHolder: 'Which repository?' }
  );
  return picked?.session;
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

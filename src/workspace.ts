/**
 * Every git repository the window has open.
 *
 * GitRay used to attach to the first workspace folder backed by a repository and stop
 * there, which meant a multi-root workspace — the normal shape for a service split across
 * repositories, or a fork checked out next to its upstream — went silent everywhere but
 * one folder, with nothing on screen to say why. This holds one session per repository and
 * gives the shared surfaces a single place to read them from.
 *
 * Lookups are by file rather than by folder. A command, a badge, or a diff knows which
 * document it is about, and that is what decides which repository answers.
 */

import * as vscode from 'vscode';
import { log } from './core/log.js';
import { Repository } from './providers/repository.js';
import { RepositorySession } from './session.js';

export class Workspace implements vscode.Disposable {
  private ordered: RepositorySession[] = [];
  private readonly attached = new Map<
    string,
    { session: RepositorySession; subscription: vscode.Disposable }
  >();
  private discovered = false;
  private announceDiscovered!: () => void;
  /**
   * Resolves once the first discovery pass has finished.
   *
   * Anything the editor can call before activation returns has to wait on this or it will
   * see an empty workspace and conclude there is nothing here. Webview restore is the case
   * that bites: VS Code calls the deserializer as soon as the serializer is registered,
   * which is well before the first `git rev-parse` has come back.
   */
  private readonly discoveredOnce = new Promise<void>((resolve) => {
    this.announceDiscovered = resolve;
  });

  /** Serializes `refresh`, so two passes cannot both attach the same folder. */
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /**
   * Fires when any session's data changes, and when the set of sessions itself does.
   *
   * One event for both, because every surface reacts to them identically: re-read
   * everything and repaint. Splitting them would only give the sidebar and the status bar
   * a way to disagree about which repositories exist.
   */
  readonly onDidChange = this.onDidChangeEmitter.event;

  /** Sessions in workspace-folder order, so the sidebar lists them the way the explorer does. */
  all(): readonly RepositorySession[] {
    return this.ordered;
  }

  get size(): number {
    return this.ordered.length;
  }

  /**
   * Has discovery run at least once?
   *
   * The difference between "no repository here" and "we have not looked yet" is the
   * difference between the sidebar's `noRepo` message and its startup message, and probing
   * a folder costs a git subprocess — long enough to show the wrong one.
   */
  get ready(): boolean {
    return this.discovered;
  }

  /** Await the first discovery pass, for callers that cannot act on an empty answer. */
  whenReady(): Promise<void> {
    return this.discoveredOnce;
  }

  /** The only session, when there is exactly one. Undefined for none, and for several. */
  only(): RepositorySession | undefined {
    return this.ordered.length === 1 ? this.ordered[0] : undefined;
  }

  /**
   * Which session owns a file.
   *
   * Deepest root wins. A repository nested inside another workspace folder — a vendored
   * dependency, a submodule opened alongside its parent — claims its own files instead of
   * losing them to the folder above, which would analyze them against the wrong history.
   */
  sessionFor(uri: vscode.Uri): RepositorySession | undefined {
    let best: RepositorySession | undefined;
    for (const session of this.ordered) {
      if (session.repository.relativePath(uri) === undefined) continue;
      if (!best || session.repository.root.length > best.repository.root.length) best = session;
    }
    return best;
  }

  /** The session for a repository root, as carried by a tree row or a diff URI. */
  sessionAt(root: string | undefined): RepositorySession | undefined {
    if (!root) return undefined;
    return this.ordered.find((session) => session.id === root);
  }

  /**
   * The session a command with nothing else to go on should act on.
   *
   * Whichever repository the active editor belongs to — that is what makes a hover card's
   * link act on the file it is attached to — and otherwise the only repository there is.
   * When neither answers, the caller asks rather than picking one.
   */
  active(): RepositorySession | undefined {
    const editor = vscode.window.activeTextEditor;
    return (editor ? this.sessionFor(editor.document.uri) : undefined) ?? this.only();
  }

  /**
   * Bring the session set in line with the editor's folder list.
   *
   * Reconciled rather than rebuilt: a folder that was already attached keeps its store, its
   * poll cadence, and its failure backoff, so adding a second folder to a workspace does
   * not restart the first one's sync — or re-fetch every pull request head it already has.
   *
   * Serialized, because the pass suspends at every `Repository.discover` and a folder event
   * arriving in that window would start a second pass that sees the same folder unattached.
   * Both would then attach it, the second overwriting the first in the map — leaving a
   * session nobody holds a reference to, still polling and still watching HEAD until the
   * window closed.
   */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    // A failed pass must not poison the chain — every later refresh would inherit the
    // rejection and never run — so the chain carries no failure forward.
    this.pending = this.pending.then(() => this.runRefresh());
    return this.pending.catch(() => {});
  }

  private async runRefresh(): Promise<void> {
    try {
      await this.reconcile();
    } finally {
      // Announced even on failure. Callers waiting on this are asking "has discovery
      // happened yet", and a pass that threw has answered that as well as one that did not
      // — leaving them waiting forever is the one outcome with no recovery.
      this.discovered = true;
      this.announceDiscovered();
    }
  }

  /**
   * One pass, abandoned the moment the workspace is disposed.
   *
   * Disposal can land while this is suspended in git — a window closing, or the extension
   * being disabled, during the discovery a folder event kicked off. A session attached after
   * that point is one `dispose()` has already walked past, so nothing will ever tear it
   * down: its poll timer and its head watcher would outlive the extension in a host that
   * keeps running. Hence a check after every await, not just at the top.
   */
  private async reconcile(): Promise<void> {
    if (this.disposed) return;

    const folders = vscode.workspace.workspaceFolders ?? [];
    const present = new Set(folders.map((folder) => folder.uri.toString()));
    let changed = false;

    // Detach first, so a repository that survives only through a folder still in the list
    // is the one holding its root when the additions below check for duplicates.
    for (const [key, entry] of [...this.attached]) {
      if (present.has(key)) continue;
      log.info(`detaching from ${entry.session.repository.root}`);
      entry.subscription.dispose();
      entry.session.dispose();
      this.attached.delete(key);
      changed = true;
    }

    const roots = new Set([...this.attached.values()].map((entry) => entry.session.id));

    for (const folder of folders) {
      const key = folder.uri.toString();
      if (this.attached.has(key)) continue;

      const repository = await Repository.discover(folder);
      if (this.disposed) return;
      if (!repository) continue;

      // Two workspace folders inside one repository are still one repository. Attaching
      // twice would double every poll and paint each set of decorations over the other.
      if (roots.has(repository.root)) continue;
      roots.add(repository.root);

      const session = new RepositorySession(repository);
      this.attached.set(key, {
        session,
        subscription: session.onDidChange(() => this.onDidChangeEmitter.fire())
      });
      changed = true;
      log.info(`attached to ${repository.root}`);
      session.start();
    }

    if (this.disposed) return;
    if (!changed && this.discovered) return;

    this.ordered = folders
      .map((folder) => this.attached.get(folder.uri.toString())?.session)
      .filter((session): session is RepositorySession => session !== undefined);

    if (this.ordered.length === 0) {
      log.info('no git repository in this workspace; GitRay is idle');
    }
    this.onDidChangeEmitter.fire();
  }

  /** Total across every repository, which is what the shared surfaces report. */
  collisionCount(): number {
    let total = 0;
    for (const session of this.ordered) total += session.scanner.collisionCount();
    return total;
  }

  dispose(): void {
    // Set before anything is torn down, so a pass suspended in git sees it the moment it
    // resumes and abandons the folder it was about to attach.
    this.disposed = true;
    // Nothing will discover anything now, and a caller blocked on `whenReady` is waiting
    // for an answer that would otherwise never come.
    this.announceDiscovered();

    for (const entry of this.attached.values()) {
      entry.subscription.dispose();
      entry.session.dispose();
    }
    this.attached.clear();
    this.ordered = [];
    this.onDidChangeEmitter.dispose();
  }
}

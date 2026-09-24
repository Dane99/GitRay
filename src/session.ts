/**
 * One repository's worth of GitRay.
 *
 * A window can have several git folders open, and none of them tells you anything about
 * the others: a pull request in one repository cannot collide with a file in another, and
 * the two have separate mainlines, separate merge bases, and separate poll cadences.
 * Everything that is per-repository is bundled here, one instance per repository.
 *
 * What is *not* here is anything the editor only lets an extension register once — the
 * sidebar, the status bar, the badges, the commands. Those live above this and read across
 * every session; see workspace.ts.
 */

import * as vscode from 'vscode';
import { configGeneration, readConfig, type Config } from './core/config.js';
import { Store } from './model/store.js';
import { Analyzer } from './model/analyzer.js';
import type { Repository } from './providers/repository.js';
import { SyncEngine } from './sync/engine.js';
import { Scheduler } from './sync/scheduler.js';
import { CollisionScanner } from './sync/scanner.js';
import { EditorController } from './ui/editorController.js';

/**
 * How long a burst of changes is gathered before the surfaces hear about it.
 *
 * One sync pass can change the store four or five times in quick succession — the muted
 * list, the open list, the fetched heads, the status, the mainline — and every surface
 * repaints in full on each announcement. Short enough that nobody sees the wait.
 */
const ANNOUNCE_DELAY_MS = 50;

/**
 * How long a burst of changes is gathered before a collision scan starts.
 *
 * A scan reads git for every file you have changed that someone else touched, so running
 * one per store change — and queueing another behind it — did the work several times over
 * for a single sync.
 */
const SCAN_DELAY_MS = 250;

export class RepositorySession implements vscode.Disposable {
  readonly store = new Store();
  readonly analyzer: Analyzer;
  readonly engine: SyncEngine;
  readonly scanner: CollisionScanner;
  readonly scheduler: Scheduler;
  readonly controller: EditorController;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /**
   * Fires whenever anything a surface renders for this repository has changed.
   *
   * Coalesced: a burst of changes arrives as one event, a moment after the last of them.
   */
  readonly onDidChange = this.onDidChangeEmitter.event;

  private announceTimer: NodeJS.Timeout | undefined;
  private scanTimer: NodeJS.Timeout | undefined;
  /** `gitray.*` for this folder, read once per settings change rather than per call. */
  private cachedConfig: { generation: number; config: Config } | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(readonly repository: Repository) {
    this.analyzer = new Analyzer(repository.git, this.store, repository.remotes);
    this.engine = new SyncEngine(repository, this.store, this.analyzer);
    this.scanner = new CollisionScanner(repository, this.store, this.analyzer);
    // Each pass starts by forgetting what the working tree looked like, so an edit made
    // outside the editor — or a checkout — is seen by the next scan.
    this.scheduler = new Scheduler(this.engine, repository, () =>
      this.scanner.workingTreeChanged()
    );
    this.controller = new EditorController(repository, this.store, this.analyzer, () =>
      this.config()
    );

    this.disposables.push(
      // A sync brings new pull request data; the scan turns it into collisions against the
      // work you have in progress. Keeping them in this order means the tree and status bar
      // never show pull requests without their collision state catching up a moment later.
      this.store.onDidChange(() => {
        this.announce();
        this.scan();
      }),
      this.scanner.onDidChange(() => this.announce()),

      // Saving can resolve or create a collision in a file that is not open, so the scan has
      // to run on save too, not just on sync. Every session hears every save, so the path
      // check is also what keeps one repository from rescanning because of the next one.
      vscode.workspace.onDidSaveTextDocument((document) => {
        const path = this.repository.relativePath(document.uri);
        if (!path) return;
        this.analyzer.invalidate(path);
        this.scanner.workingTreeChanged();
        this.scan();
      })
    );
  }

  /**
   * What identifies this session everywhere.
   *
   * The repository root rather than the workspace folder, because that is what the thing
   * actually is: two folders opened inside one repository are one repository, and a path
   * in a diff URI can be traced back to a root but not to a folder.
   */
  get id(): string {
    return this.repository.root;
  }

  /** What to call it on screen. */
  get label(): string {
    return this.repository.folder.name;
  }

  /**
   * This folder's settings.
   *
   * Cached, because it is read on every paint and every analysis and the editor builds a
   * fresh configuration object each time it is asked. See `configGeneration` for what
   * keeps it current.
   */
  config(): Config {
    const current = configGeneration();
    if (current === undefined) return readConfig(this.repository.folder.uri);
    if (!this.cachedConfig || this.cachedConfig.generation !== current) {
      this.cachedConfig = { generation: current, config: readConfig(this.repository.folder.uri) };
    }
    return this.cachedConfig.config;
  }

  start(): void {
    this.scheduler.start();
  }

  /** Ask for a collision scan, soon. Repeated asks before it starts become one scan. */
  scan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      void this.scanner.scan(this.config());
    }, SCAN_DELAY_MS);
  }

  private announce(): void {
    if (this.announceTimer) return;
    this.announceTimer = setTimeout(() => {
      this.announceTimer = undefined;
      this.onDidChangeEmitter.fire();
    }, ANNOUNCE_DELAY_MS);
  }

  dispose(): void {
    if (this.announceTimer) clearTimeout(this.announceTimer);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.announceTimer = undefined;
    this.scanTimer = undefined;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
    this.scheduler.dispose();
    this.controller.dispose();
    this.scanner.dispose();
    this.store.dispose();
    this.repository.git.dispose();
    this.onDidChangeEmitter.dispose();
  }
}

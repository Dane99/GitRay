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
import { readConfig, type Config } from './core/config.js';
import { Store } from './model/store.js';
import { Analyzer } from './model/analyzer.js';
import type { Repository } from './providers/repository.js';
import { SyncEngine } from './sync/engine.js';
import { Scheduler } from './sync/scheduler.js';
import { CollisionScanner } from './sync/scanner.js';
import { EditorController } from './ui/editorController.js';

export class RepositorySession implements vscode.Disposable {
  readonly store = new Store();
  readonly analyzer: Analyzer;
  readonly engine: SyncEngine;
  readonly scanner: CollisionScanner;
  readonly scheduler: Scheduler;
  readonly controller: EditorController;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever anything a surface renders for this repository has changed. */
  readonly onDidChange = this.onDidChangeEmitter.event;

  private disposables: vscode.Disposable[] = [];

  constructor(readonly repository: Repository) {
    this.analyzer = new Analyzer(repository.git, this.store, repository.remotes);
    this.engine = new SyncEngine(repository, this.store, this.analyzer);
    this.scanner = new CollisionScanner(repository, this.store, this.analyzer);
    this.scheduler = new Scheduler(this.engine, repository);
    this.controller = new EditorController(repository, this.store, this.analyzer);

    this.disposables.push(
      // A sync brings new pull request data; the scan turns it into collisions against the
      // work you have in progress. Keeping them in this order means the tree and status bar
      // never show pull requests without their collision state catching up a moment later.
      this.store.onDidChange(() => {
        this.onDidChangeEmitter.fire();
        this.scan();
      }),
      this.scanner.onDidChange(() => this.onDidChangeEmitter.fire()),

      // Saving can resolve or create a collision in a file that is not open, so the scan has
      // to run on save too, not just on sync. Every session hears every save, so the path
      // check is also what keeps one repository from rescanning because of the next one.
      vscode.workspace.onDidSaveTextDocument((document) => {
        const path = this.repository.relativePath(document.uri);
        if (!path) return;
        this.analyzer.invalidate(path);
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

  config(): Config {
    return readConfig(this.repository.folder.uri);
  }

  start(): void {
    this.scheduler.start();
  }

  scan(): void {
    void this.scanner.scan(this.config());
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
    this.scheduler.dispose();
    this.controller.dispose();
    this.scanner.dispose();
    this.store.dispose();
    this.onDidChangeEmitter.dispose();
  }
}

/**
 * Decides *when* to sync.
 *
 * The rules are chosen so GitRay feels immediate when you are working and costs nothing
 * when you are not: refresh on the events that actually imply new information (you came
 * back to the window, you saved, HEAD moved), poll gently otherwise, and stop entirely
 * while the window is in the background.
 */

import * as vscode from 'vscode';
import { log } from '../core/log.js';
import { readConfig } from '../core/config.js';
import type { SyncEngine } from './engine.js';
import type { Repository } from '../providers/repository.js';

const MIN_GAP_MS = 5_000;
const MAX_BACKOFF_MS = 10 * 60_000;

export class Scheduler implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];
  private running = false;
  private queued = false;
  private lastRunAt = 0;
  private consecutiveFailures = 0;
  private disposed = false;

  constructor(
    private readonly engine: SyncEngine,
    private readonly repository: Repository
  ) {}

  start(): void {
    const headWatcher = this.repository.createHeadWatcher();
    this.disposables.push(
      headWatcher,
      headWatcher.onDidChange(() => this.request('HEAD changed')),
      headWatcher.onDidCreate(() => this.request('HEAD changed')),

      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.request('window focused');
        else this.stopTimer();
      }),

      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.repository.relativePath(document.uri)) this.request('file saved');
      }),

      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('gitray')) this.request('settings changed');
      })
    );

    void this.request('startup');
  }

  /**
   * Ask for a sync.
   *
   * Coalescing matters here: several triggers commonly fire together — saving a file
   * during a rebase, for instance — and each one must not become its own network call.
   */
  async request(reason: string): Promise<void> {
    if (this.disposed) return;

    if (this.running) {
      this.queued = true;
      return;
    }

    const sinceLast = Date.now() - this.lastRunAt;
    if (sinceLast < MIN_GAP_MS && reason !== 'manual') {
      this.scheduleNext(MIN_GAP_MS - sinceLast);
      return;
    }

    this.running = true;
    this.stopTimer();
    log.debug(`sync: ${reason}`);

    try {
      const config = readConfig(this.repository.folder.uri);
      await this.engine.sync(config);
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures++;
      log.error('scheduled sync failed', error);
    } finally {
      this.running = false;
      this.lastRunAt = Date.now();
    }

    if (this.queued) {
      this.queued = false;
      this.scheduleNext(MIN_GAP_MS);
      return;
    }

    this.scheduleNext(this.nextDelay());
  }

  /**
   * Delay before the next automatic pass.
   *
   * Backoff doubles per consecutive failure up to ten minutes. Without it, a repository
   * whose remote is unreachable would retry every 60 seconds forever, and each attempt
   * costs a process spawn and a stalled connection.
   */
  private nextDelay(): number {
    const config = readConfig(this.repository.folder.uri);
    if (config.refreshInterval <= 0) return 0;

    const base = Math.max(config.refreshInterval, 5) * 1000;
    if (this.consecutiveFailures === 0) return base;

    return Math.min(base * 2 ** this.consecutiveFailures, MAX_BACKOFF_MS);
  }

  private scheduleNext(delay: number): void {
    this.stopTimer();
    if (delay <= 0 || this.disposed) return;
    if (!vscode.window.state.focused) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.request('interval');
    }, delay);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
  }
}

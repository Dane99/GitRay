/**
 * Repository-wide collision scan.
 *
 * The editor decorations only know about files you have open, but the question "am I
 * about to conflict with anyone?" is about your whole branch. This scans the intersection
 * of two sets — files you have diverged on, and files someone else touched — which is
 * small in practice even in a busy repository, and is where every real conflict must live.
 *
 * "Someone else" includes the mainline. Work that already merged is not a forecast any
 * more, so the scan runs even when nothing is open, on the strength of the mainline having
 * moved alone.
 *
 * Unsaved editor content is preferred over what is on disk, so a conflict you just typed
 * shows up before you save.
 */

import * as vscode from 'vscode';
import type { FileAnalysis, MainlineState, PullRequest } from '../core/types.js';
import type { Config } from '../core/config.js';
import { log } from '../core/log.js';
import { matchesAny } from '../core/glob.js';
import type { Analyzer } from '../model/analyzer.js';
import type { Store } from '../model/store.js';
import type { Repository } from '../providers/repository.js';

/** Ceiling on files analyzed per scan, so a branch that rewrites the world stays responsive. */
const MAX_FILES = 200;

export class CollisionScanner implements vscode.Disposable {
  private results = new Map<string, FileAnalysis>();
  private scanning = false;
  private rescanQueued = false;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    private readonly repository: Repository,
    private readonly store: Store,
    private readonly analyzer: Analyzer
  ) {}

  /** Every analyzed file that has at least one non-ambient region. */
  hotFiles(): FileAnalysis[] {
    return [...this.results.values()]
      .filter((analysis) => analysis.regions.some((region) => region.severity !== 'ambient'))
      .sort((a, b) => collisionCount(b) - collisionCount(a) || a.path.localeCompare(b.path));
  }

  analysisFor(path: string): FileAnalysis | undefined {
    return this.results.get(path);
  }

  collisionCount(): number {
    let total = 0;
    for (const analysis of this.results.values()) {
      total += collisionCount(analysis);
    }
    return total;
  }

  async scan(config: Config): Promise<void> {
    if (this.scanning) {
      this.rescanQueued = true;
      return;
    }
    this.scanning = true;

    try {
      await this.runScan(config);
    } catch (error) {
      log.error('collision scan failed', error);
    } finally {
      this.scanning = false;
      if (this.rescanQueued) {
        this.rescanQueued = false;
        void this.scan(config);
      }
    }
  }

  private async runScan(config: Config): Promise<void> {
    const pullRequests = this.store.allPullRequests();
    const mainline = config.trackMainlineDrift ? this.store.mainline() : undefined;
    const drifted = mainline !== undefined && mainline.tip !== mainline.base;

    // With nothing open and a mainline that has not moved there is genuinely nothing to
    // compare against. Either one on its own is reason enough to scan.
    if (pullRequests.length === 0 && !drifted) {
      this.publish(new Map());
      return;
    }

    const candidates = await this.candidates(config, pullRequests, drifted ? mainline : undefined);

    if (candidates.size > MAX_FILES) {
      log.debug(`collision scan: ${candidates.size} candidates exceeds cap, truncating`);
    }

    const results = new Map<string, FileAnalysis>();
    for (const path of [...candidates].slice(0, MAX_FILES)) {
      const current = await this.readCurrentText(path);
      if (current === undefined) continue;

      const analysis = await this.analyzer.analyze(path, current.text, current.version, pullRequests, {
        proximityLines: config.proximityLines,
        maxRegionsPerFile: config.maxRegionsPerFile,
        mainline
      });
      if (analysis.regions.length > 0) results.set(path, analysis);
    }

    this.publish(results);
  }

  /**
   * Files worth analyzing: the ones you have diverged on that someone else also touched.
   *
   * "Someone else" now has two meanings, and they need different intersections. An open
   * pull request contributes the files in its own index; the mainline contributes the
   * files that changed between where you left it and where it is now. Both are intersected
   * with your own divergence, because a conflict cannot live anywhere else.
   */
  private async candidates(
    config: Config,
    pullRequests: readonly PullRequest[],
    mainline: MainlineState | undefined
  ): Promise<Set<string>> {
    const candidates = new Set<string>();
    const keep = (path: string, theirs: ReadonlySet<string>) =>
      theirs.has(path) && !matchesAny(path, config.ignoreGlobs);

    if (pullRequests.length > 0) {
      const touched = new Set(this.store.allTouchedPaths());
      // One `git diff --name-only` per distinct merge base — normally just one, since
      // every pull request branches off the same base commit.
      for (const baseSha of await this.distinctMergeBases(pullRequests)) {
        for (const path of await this.repository.git.changedSince(baseSha)) {
          if (keep(path, touched)) candidates.add(path);
        }
      }
    }

    if (mainline) {
      const landed = new Set(
        await this.repository.git.changedPaths(mainline.base, mainline.tip)
      );
      for (const path of await this.repository.git.changedSince(mainline.base)) {
        if (keep(path, landed)) candidates.add(path);
      }
    }

    return candidates;
  }

  /** One merge base per pull request, answered from the analyzer's cache. */
  private async distinctMergeBases(pullRequests: readonly PullRequest[]): Promise<string[]> {
    const bases = new Set<string>();
    for (const pr of pullRequests) {
      const base = await this.analyzer.mergeBaseFor(pr);
      if (base) bases.add(base);
    }
    return [...bases];
  }

  /**
   * Current content of a file: what is in the editor if it is open, otherwise disk.
   *
   * The editor copy is authoritative because unsaved edits are exactly the ones you have
   * not had a chance to discover a conflict in yet.
   *
   * The version is what keys the analyzer's alignment cache, so it must actually change
   * when the content does: the document's own version for open files — the same value the
   * editor controller uses, so the two share cache entries — and the mtime for files read
   * from disk. A constant here would silently serve alignments computed from an earlier
   * state of the buffer.
   */
  private async readCurrentText(
    path: string
  ): Promise<{ text: string; version: number } | undefined> {
    const uri = this.repository.uriFor(path);

    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString()
    );
    if (open) return { text: open.getText(), version: open.version };

    try {
      const [stat, bytes] = await Promise.all([
        vscode.workspace.fs.stat(uri),
        vscode.workspace.fs.readFile(uri)
      ]);
      return { text: Buffer.from(bytes).toString('utf8'), version: stat.mtime };
    } catch {
      // Deleted locally, or binary and unreadable as text; either way there is nothing
      // useful to line up against the merge base.
      return undefined;
    }
  }

  /**
   * Publish results on the scanner's own event.
   *
   * Deliberately does not write back to the store. A scan is triggered *by* a store
   * change, so updating the store here would retrigger it — an endless scan/publish
   * loop. The collision count lives on the scanner, and every surface that needs it
   * reads it from here.
   */
  private publish(results: Map<string, FileAnalysis>): void {
    this.results = results;
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

function collisionCount(analysis: FileAnalysis): number {
  return analysis.regions.filter((region) => region.severity === 'collision').length;
}

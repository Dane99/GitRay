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
import type { FileAnalysis, MainlineState, PullRequest, ResolvedRegion } from '../core/types.js';
import { MAX_SCANNED_FILES, originKey } from '../core/types.js';
import type { Config } from '../core/config.js';
import { log } from '../core/log.js';
import { matchesAny } from '../core/glob.js';
import { inParallel } from '../core/parallel.js';
import type { Analyzer } from '../model/analyzer.js';
import type { Store } from '../model/store.js';
import type { Repository } from '../providers/repository.js';

const MAX_FILES = MAX_SCANNED_FILES;

/**
 * Files analyzed at once. Analysis mostly waits — on the blob reader, on a yielding
 * alignment — so a few in flight overlap that waiting without piling up work.
 */
const ANALYSIS_CONCURRENCY = 4;

export class CollisionScanner implements vscode.Disposable {
  private results = new Map<string, FileAnalysis>();
  private hot: readonly FileAnalysis[] | undefined;
  /** Whether anything has been published yet; the first result is always announced. */
  private published = false;
  private scanning = false;
  private rescanQueued = false;
  /**
   * `git diff --name-only <base>` per base, until the working tree may have changed.
   *
   * That diff stats every file in the working tree, and a scan asked it once per distinct
   * merge base plus once for the mainline — on every scan, although only a save, a HEAD
   * move, or something outside the editor can change the answer.
   */
  private changed = new Map<string, Promise<string[]>>();
  /** The files the mainline changed, for the range it was last asked about. */
  private landed: { key: string; paths: Promise<string[]> } | undefined;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    private readonly repository: Repository,
    private readonly store: Store,
    private readonly analyzer: Analyzer
  ) {}

  /** Every analyzed file that has at least one non-ambient region. */
  hotFiles(): readonly FileAnalysis[] {
    // Computed once per published scan: the tree, the badges, and the radar each ask
    // several times per refresh.
    this.hot ??= [...this.results.values()]
      .filter((analysis) => analysis.regions.some((region) => region.severity !== 'ambient'))
      .sort((a, b) => collisionCount(b) - collisionCount(a) || a.path.localeCompare(b.path));
    return this.hot;
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

  /**
   * Forget which files the working tree has changed. Call on save, when HEAD moves, and
   * once per sync pass to catch edits made outside the editor.
   */
  workingTreeChanged(): void {
    this.changed.clear();
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

    // Built once rather than searched per file: `textDocuments` is a fresh array on every
    // read, and comparing URIs as strings for each of two hundred files adds up.
    const open = new Map(
      vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document])
    );

    const scanned = [...candidates].slice(0, MAX_FILES);

    // Merge bases and diffs for every pull request that touches a candidate, read a few at
    // a time before any file is analyzed. Analysis would otherwise ask for them one by one,
    // each a git process waiting behind the last.
    const wanted = new Set(scanned);
    await this.analyzer.warm(
      pullRequests.filter((pr) => pr.files.some((file) => wanted.has(file.path)))
    );

    const results = new Map<string, FileAnalysis>();
    await inParallel(scanned, ANALYSIS_CONCURRENCY, async (path) => {
      const current = await this.readCurrentText(path, open);
      if (current === undefined) return;

      const analysis = await this.analyzer.analyze(path, current.text, current.version, pullRequests, {
        proximityLines: config.proximityLines,
        maxRegionsPerFile: config.maxRegionsPerFile,
        mainline
      });
      if (analysis.regions.length > 0) results.set(path, analysis);
    });

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
      // One `git diff --name-only` per commit your edits are measured from, which is where
      // your branch left the mainline — one commit, in practice. Measuring from each pull
      // request's own merge base instead was one working-tree diff per distinct base, and
      // in a busy repository there are dozens; worse, everything that landed upstream after
      // an old pull request branched counted as your change, which turned forty edited
      // files into seven hundred candidates.
      for (const baseSha of await this.distinctYourBases(pullRequests)) {
        for (const path of await this.changedSince(baseSha)) {
          if (keep(path, touched)) candidates.add(path);
        }
      }
    }

    if (mainline) {
      const landed = new Set(await this.landedBetween(mainline.base, mainline.tip));
      for (const path of await this.changedSince(mainline.base)) {
        if (keep(path, landed)) candidates.add(path);
      }
    }

    return candidates;
  }

  /** Files the mainline changed between two commits, which never changes for a pair. */
  private landedBetween(base: string, tip: string): Promise<string[]> {
    const key = `${base}..${tip}`;
    if (this.landed?.key !== key) {
      this.landed = { key, paths: this.repository.git.changedPaths(base, tip) };
    }
    return this.landed.paths;
  }

  private changedSince(baseSha: string): Promise<string[]> {
    let pending = this.changed.get(baseSha);
    if (!pending) {
      pending = this.repository.git.changedSince(baseSha);
      this.changed.set(baseSha, pending);
    }
    return pending;
  }

  /**
   * The distinct commits your edits are measured from, across these pull requests.
   *
   * Answered per base branch where the mainline copy is known, so a hundred pull requests
   * into `main` are one lookup; a pull request into a branch with no local copy falls back
   * to its own merge base, the same as `ownEdits` does.
   */
  private async distinctYourBases(pullRequests: readonly PullRequest[]): Promise<string[]> {
    const bases = new Set<string>();
    for (const pr of pullRequests) {
      const base = await this.analyzer.yourBaseFor(pr);
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
    path: string,
    openDocuments: ReadonlyMap<string, vscode.TextDocument>
  ): Promise<{ text: string; version: number } | undefined> {
    const uri = this.repository.uriFor(path);

    const open = openDocuments.get(uri.toString());
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
    // A scan that found exactly what the last one did has nothing to announce. Every
    // surface repaints on this event, and most scans are triggered by something that did
    // not move a single collision.
    const unchanged = this.published && sameResults(this.results, results);
    this.results = results;
    this.hot = undefined;
    this.published = true;
    if (!unchanged) this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

/**
 * Would every surface render these two scans identically?
 *
 * Compares what the surfaces read — which files, which regions, where, and how severe — so
 * a rescan that merely rebuilt equal objects does not count as news.
 */
function sameResults(
  a: ReadonlyMap<string, FileAnalysis>,
  b: ReadonlyMap<string, FileAnalysis>
): boolean {
  if (a.size !== b.size) return false;
  for (const [path, mine] of a) {
    const theirs = b.get(path);
    if (!theirs || mine.degraded !== theirs.degraded) return false;
    if (mine.regions.length !== theirs.regions.length) return false;
    for (let i = 0; i < mine.regions.length; i++) {
      if (!sameRegion(mine.regions[i], theirs.regions[i])) return false;
    }
  }
  return true;
}

function sameRegion(a: ResolvedRegion, b: ResolvedRegion): boolean {
  return (
    a.severity === b.severity &&
    a.distance === b.distance &&
    a.author === b.author &&
    a.baseSha === b.baseSha &&
    a.range.start === b.range.start &&
    a.range.end === b.range.end &&
    a.baseRange.start === b.baseRange.start &&
    a.baseRange.end === b.baseRange.end &&
    originKey(a.origin) === originKey(b.origin) &&
    // Mainline origins carry their commits; a new commit touching the same lines is news.
    (a.origin.kind !== 'mainline' ||
      b.origin.kind !== 'mainline' ||
      a.origin.commits.length === b.origin.commits.length) &&
    a.added.length === b.added.length &&
    a.removed.length === b.removed.length
  );
}

function collisionCount(analysis: FileAnalysis): number {
  return analysis.regions.filter((region) => region.severity === 'collision').length;
}

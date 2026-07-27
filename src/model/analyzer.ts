/**
 * Turns "what everyone else changed" plus "what you have on screen" into renderable
 * regions with a severity.
 *
 * The flow for one file, per pull request:
 *
 *   merge base  ──git diff──▶  their changed ranges   (base coordinates)
 *        │
 *        └──git show──▶ base text ──jsdiff vs buffer──▶ your changed ranges (base coords)
 *                                                    └▶ base ➜ buffer line map
 *
 * Their ranges and yours are compared in base coordinates to decide severity, then their
 * ranges go through the line map to decide where to draw. Both come out of the same
 * alignment, which is why collision detection costs almost nothing on top of rendering.
 *
 * The mainline is analyzed as one more collaborator, and it is the cheapest one of the
 * lot. Its base is where your branch left the mainline — the commit this file already
 * aligns the buffer against, to work out which edits are yours — so its regions cost one
 * diff and reuse an alignment that was computed anyway. See `mainlineRegions`.
 */

import type {
  ChangeRegion,
  FileAnalysis,
  LineRange,
  MainlineCommit,
  MainlineState,
  PullRequest,
  ResolvedRegion
} from '../core/types.js';
import { originKey } from '../core/types.js';
import type { Git } from '../providers/git.js';
import { prRef } from '../providers/git.js';
import { alignLines, splitLines, type Alignment } from './lineMap.js';
import { classifyProximity } from './collision.js';
import type { Store } from './store.js';
import { log } from '../core/log.js';

export interface AnalyzeOptions {
  proximityLines: number;
  maxRegionsPerFile: number;
  /** Where the mainline is, when drift tracking is on and the branch is known. */
  mainline?: MainlineState;
}

/**
 * Bounded caches.
 *
 * Base blobs and alignments are the expensive parts. Blobs are keyed by commit and path
 * so they survive editing; alignments additionally include the document version, so they
 * fall out naturally as you type.
 */
const MAX_BLOBS = 256;
const MAX_ALIGNMENTS = 64;
const MAX_DRIFT = 256;

export class Analyzer {
  private readonly mergeBases = new Map<string, string | undefined>();
  private readonly mainlines = new Map<string, string | undefined>();
  private readonly blobs = new Map<string, string[]>();
  private readonly alignments = new Map<string, Alignment>();
  /** Mainline drift per file, keyed by the base and tip it was computed between. */
  private readonly drift = new Map<string, ChangeRegion[]>();

  constructor(
    private readonly git: Git,
    private readonly store: Store
  ) {}

  /** Drop everything derived from git state. Call when HEAD moves. */
  reset(): void {
    this.mergeBases.clear();
    this.mainlines.clear();
    this.blobs.clear();
    this.alignments.clear();
    this.drift.clear();
  }

  /** Drop cached alignments for one file, e.g. when it was saved or reverted. */
  invalidate(path: string): void {
    for (const key of this.alignments.keys()) {
      if (key.includes(`\0${path}\0`)) this.alignments.delete(key);
    }
  }

  /**
   * Analyze one file against every pull request that touches it, and against the mainline.
   *
   * `documentVersion` only participates in cache keying; pass the editor's version so
   * alignments are reused between decoration passes for an unchanged buffer.
   */
  async analyze(
    path: string,
    bufferText: string,
    documentVersion: number,
    pullRequests: readonly PullRequest[],
    options: AnalyzeOptions
  ): Promise<FileAnalysis> {
    const relevant = pullRequests.filter((pr) =>
      pr.files.some((file) => file.path === path)
    );

    // The mainline is checked even with nothing open, which is the point: a pull request
    // that merged is gone from the list at exactly the moment its overlap stops being a
    // forecast. Returning early on an empty list would go quiet right then.
    if (relevant.length === 0 && !options.mainline) {
      return { path, regions: [], degraded: false };
    }

    const bufferLines = splitLines(bufferText);
    const resolved: ResolvedRegion[] = [];
    let degraded = false;

    for (const pr of relevant) {
      const baseSha = await this.mergeBaseFor(pr);
      if (!baseSha) {
        // Unrelated histories or a shallow clone: no shared coordinate system exists, so
        // the file-level indicator is the honest answer here.
        degraded = true;
        continue;
      }

      const regions = await this.regionsFor(path, pr, baseSha);
      if (regions.length === 0) continue;

      const alignment = await this.alignmentFor(path, baseSha, bufferLines, documentVersion);
      const ownEdits = await this.ownEdits(
        path,
        pr.baseRefName,
        bufferLines,
        documentVersion,
        alignment
      );

      for (const region of regions) {
        const proximity = classifyProximity(
          region.baseRange,
          ownEdits,
          options.proximityLines
        );
        resolved.push({
          ...region,
          range: alignment.toBufferRange(region.baseRange),
          severity: proximity.severity,
          overlapsWith: proximity.nearest,
          distance: proximity.distance
        });
      }
    }

    if (options.mainline) {
      resolved.push(
        ...(await this.mainlineRegions(
          path,
          options.mainline,
          bufferLines,
          documentVersion,
          options.proximityLines
        ))
      );
    }

    if (resolved.length > options.maxRegionsPerFile) {
      // A wholesale reformat or generated-file churn can produce thousands of regions.
      // Rendering them all would be noise anyway, so fall back to a file-level signal.
      log.debug(`${path}: ${resolved.length} regions exceeds cap, degrading to file level`);
      return { path, regions: [], degraded: true };
    }

    resolved.sort(
      (a, b) =>
        a.range.start - b.range.start ||
        originKey(a.origin).localeCompare(originKey(b.origin))
    );
    return { path, regions: resolved, degraded };
  }

  /**
   * What landed on the mainline since your branch left it, for one file.
   *
   * The coordinate system falls out for free. Your own edits are already measured against
   * `mainline.base` — that is what `ownEdits` does, to keep upstream work from being
   * mistaken for yours — so the diff from that same commit to the mainline tip lands in
   * exactly the coordinates severity has to be judged in. No remapping, and the alignment
   * is the one the pull request pass already paid for.
   *
   * Ambient drift is dropped rather than rendered. An open pull request is a forecast, so
   * "someone is working here" earns a quiet mark; a merged commit is history, and marking
   * every line the mainline has moved since you branched would light up half the repository
   * with things that have nothing to do with you. It is only news where it meets your work.
   */
  private async mainlineRegions(
    path: string,
    mainline: MainlineState,
    bufferLines: string[],
    documentVersion: number,
    proximityLines: number
  ): Promise<ResolvedRegion[]> {
    if (mainline.tip === mainline.base) return [];

    const regions = await this.driftRegions(path, mainline);
    if (regions.length === 0) return [];

    const alignment = await this.alignmentFor(
      path,
      mainline.base,
      bufferLines,
      documentVersion
    );

    const resolved: ResolvedRegion[] = [];
    for (const region of regions) {
      const proximity = classifyProximity(
        region.baseRange,
        alignment.localEdits,
        proximityLines
      );
      if (proximity.severity === 'ambient') continue;

      resolved.push({
        ...region,
        range: alignment.toBufferRange(region.baseRange),
        severity: proximity.severity,
        overlapsWith: proximity.nearest,
        distance: proximity.distance
      });
    }
    return resolved;
  }

  /**
   * The mainline's changes to one file, in the coordinates of where you left it.
   *
   * Cached against both ends of the range, so the entry falls out on its own when the
   * mainline is fetched forward or HEAD moves, without anything having to invalidate it.
   */
  private async driftRegions(
    path: string,
    mainline: MainlineState
  ): Promise<ChangeRegion[]> {
    const key = `${mainline.base}\0${mainline.tip}\0${path}`;
    const cached = this.drift.get(key);
    if (cached) return cached;

    const [diffs, commits] = await Promise.all([
      this.git.diffRange(mainline.base, mainline.tip, [path]),
      this.git.commitsIn(mainline.base, mainline.tip, path)
    ]);

    // One origin object shared by every region in the file: they all describe the same
    // set of commits, and the surfaces read it rather than copying out of it.
    const origin = {
      kind: 'mainline' as const,
      branch: mainline.branch,
      commits
    };
    const author = attributeDrift(commits, mainline.branch);

    const regions: ChangeRegion[] = [];
    for (const file of diffs) {
      if (file.isBinary) continue;
      // A pathspec can still return the pre-rename path; accept either side.
      if (file.path !== path && file.oldPath !== path) continue;

      for (const hunk of file.hunks) {
        regions.push({
          origin,
          author,
          baseSha: mainline.base,
          baseRange: hunk.baseRange,
          kind: hunk.kind,
          removed: hunk.removed,
          added: hunk.added
        });
      }
    }

    evict(this.drift, MAX_DRIFT);
    this.drift.set(key, regions);
    return regions;
  }

  /**
   * Your own changes to a file, expressed in the pull request's merge-base coordinates.
   *
   * "Yours" means what you have diverged by since leaving the mainline — uncommitted work
   * plus commits on your branch — and deliberately excludes anything that merely landed
   * upstream after this pull request branched off. Those upstream overlaps are genuine
   * conflicts for the pull request's author to rebase away, but they are not your problem,
   * and counting them would light up a clean checkout with warnings about work nobody did.
   *
   * The edits are discovered against the mainline and then mapped back through the merge
   * base alignment, because conflict severity has to be judged in one coordinate system.
   */
  private async ownEdits(
    path: string,
    baseRefName: string,
    bufferLines: string[],
    documentVersion: number,
    mergeBaseAlignment: Alignment
  ): Promise<LineRange[]> {
    const mainline = await this.mainlineFor(baseRefName);
    // With no remote-tracking branch to compare against there is no way to separate your
    // work from upstream, so fall back to the merge base and accept the extra noise.
    if (!mainline) return mergeBaseAlignment.localEdits;

    const alignment = await this.alignmentFor(path, mainline, bufferLines, documentVersion);
    return alignment.bufferEdits.map((range) => mergeBaseAlignment.toBaseRange(range));
  }

  /** Where your branch left the mainline, cached per base branch. */
  private async mainlineFor(baseRefName: string): Promise<string | undefined> {
    if (this.mainlines.has(baseRefName)) return this.mainlines.get(baseRefName);

    const mainline = await this.git.mainlineBase(baseRefName);
    this.mainlines.set(baseRefName, mainline);
    if (!mainline) {
      log.debug(`no remote-tracking ref for ${baseRefName}; using merge base for local edits`);
    }
    return mainline;
  }

  /**
   * Merge base of HEAD and a pull request head, cached against the head commit.
   *
   * Public because the collision scanner needs the same answer: sharing the cache saves
   * a `git merge-base` spawn per pull request per scan, and guarantees the scanner and
   * the per-file analysis can never disagree about which commit is the base.
   */
  async mergeBaseFor(pr: PullRequest): Promise<string | undefined> {
    const key = pr.headRefOid;
    if (this.mergeBases.has(key)) return this.mergeBases.get(key);

    const base = await this.git.mergeBase(prRef(pr.number));
    this.mergeBases.set(key, base);
    if (!base) {
      log.debug(`no merge base for #${pr.number}; skipping line-level analysis`);
    }
    return base;
  }

  /** A pull request's changes to one file, in base coordinates. */
  private async regionsFor(
    path: string,
    pr: PullRequest,
    baseSha: string
  ): Promise<ChangeRegion[]> {
    const cached = this.store.cachedRegions(path, pr.number, pr.headRefOid);
    if (cached) return cached;

    const diffs = await this.git.diffRange(baseSha, prRef(pr.number), [path]);
    const regions: ChangeRegion[] = [];

    for (const file of diffs) {
      if (file.isBinary) continue;
      // A pathspec can still return the pre-rename path; accept either side.
      if (file.path !== path && file.oldPath !== path) continue;

      for (const hunk of file.hunks) {
        regions.push({
          origin: { kind: 'pullRequest', prNumber: pr.number },
          author: pr.author,
          baseSha,
          baseRange: hunk.baseRange,
          kind: hunk.kind,
          removed: hunk.removed,
          added: hunk.added
        });
      }
    }

    this.store.cacheRegions(path, pr.number, pr.headRefOid, baseSha, regions);
    return regions;
  }

  /** Alignment between a base commit's copy of the file and the live buffer. */
  private async alignmentFor(
    path: string,
    baseSha: string,
    bufferLines: string[],
    documentVersion: number
  ): Promise<Alignment> {
    const key = `${baseSha}\0${path}\0${documentVersion}`;
    const cached = this.alignments.get(key);
    if (cached) return cached;

    const baseLines = await this.baseLines(baseSha, path);
    const alignment = alignLines(baseLines, bufferLines);

    evict(this.alignments, MAX_ALIGNMENTS);
    this.alignments.set(key, alignment);
    return alignment;
  }

  private async baseLines(baseSha: string, path: string): Promise<string[]> {
    const key = `${baseSha}\0${path}`;
    const cached = this.blobs.get(key);
    if (cached) return cached;

    const content = await this.git.showFile(baseSha, path);
    // A file the collaborator created does not exist at the merge base. Treating that as
    // an empty file is correct: everything in your copy is then your own local content.
    const lines = content === undefined ? [''] : splitLines(content);

    evict(this.blobs, MAX_BLOBS);
    this.blobs.set(key, lines);
    return lines;
  }
}

/**
 * Who to credit for mainline drift in one file.
 *
 * A single author gets named, because "Priya's change landed on main and it touches your
 * lines" is the useful sentence. Once several people are involved there is no honest way
 * to pick one, and the branch itself is the truthful answer — the hover carries the full
 * list either way.
 */
function attributeDrift(commits: readonly MainlineCommit[], branch: string): string {
  const authors = new Set(commits.map((commit) => commit.author));
  const only = commits[0];
  return authors.size === 1 && only ? only.author : branch;
}

/** Drop the oldest entry once a cache is full. Insertion order is Map's iteration order. */
function evict<K, V>(cache: Map<K, V>, limit: number): void {
  while (cache.size >= limit) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

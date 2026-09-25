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
 *
 * Git is asked in bulk, never per file. A pull request's diff is read once for every file
 * it touches, the mainline's once for the whole range, and base copies come through one
 * long-lived `cat-file` process — a collision scan over two hundred files used to be a
 * thousand process spawns, one after another.
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
import { compareOrigins, MAX_SCANNED_FILES } from '../core/types.js';
import type { Git } from '../providers/git.js';
import { GITRAY_NAMESPACE, prRef } from '../providers/git.js';
import type { RemoteSelector } from '../providers/remoteSelection.js';
import type { FileDiff } from './diffParse.js';
import { alignLinesAsync, splitLines, type Alignment } from './lineMap.js';
import { classifyProximity } from './collision.js';
import type { Store } from './store.js';
import { log } from '../core/log.js';
import { inParallel } from '../core/parallel.js';

export interface AnalyzeOptions {
  proximityLines: number;
  maxRegionsPerFile: number;
  /** Where the mainline is, when drift tracking is on and the branch is known. */
  mainline?: MainlineState;
}

/**
 * Bounded caches, evicted least-recently-used.
 *
 * Base blobs and alignments are the expensive parts. Blobs are keyed by commit and path
 * so they survive editing; alignments additionally include the document version, so they
 * fall out naturally as you type.
 *
 * Both are sized to hold a whole collision scan — up to two bases per file — with room left
 * for the editors on screen. Anything smaller and a scan evicts its own entries before the
 * next scan can reuse them, which turns every scan into a cold one.
 */
const MAX_BLOBS = MAX_SCANNED_FILES * 2 + 64;
const MAX_ALIGNMENTS = MAX_SCANNED_FILES * 2 + 64;
/** Mainline ranges kept. The tip only moves forward, so older ranges are rarely revisited. */
const MAX_DRIFT_RANGES = 4;

/**
 * Output accepted from a whole-range mainline diff.
 *
 * A branch left behind for a while can be a large diff. Past this the per-file fallback
 * takes over rather than drift going dark.
 */
const DRIFT_DIFF_MAX_BUFFER = 128 * 1024 * 1024;

/**
 * Past this many characters of pathspec, a pull request is diffed without one.
 *
 * Windows caps a command line at 32K characters. The diff is filtered down to the files that
 * matter afterwards either way; the pathspec only saves git the work.
 */
const MAX_PATHSPEC_CHARS = 16_000;

/**
 * The most commits HEAD can gain and still count as a small step forward. Past it the
 * `--contains` check would cost more than recomputing, so everything is recomputed.
 */
const MAX_HEAD_ADVANCE = 50;

/** Git processes `warm` keeps running at once. */
const WARM_CONCURRENCY = 4;

/** An alignment that was tried and abandoned, so it is not tried again for this version. */
const TOO_FAR_APART = null;

/** Every path in a range of history, mapped to the regions changed there. */
type DriftIndex = (path: string) => Promise<ChangeRegion[]>;

export class Analyzer {
  private readonly mergeBases = new Map<string, string | undefined>();
  private readonly mainlines = new Map<string, string | undefined>();
  private readonly blobs = new Map<string, string[]>();
  private readonly alignments = new Map<string, Alignment | typeof TOO_FAR_APART>();
  /** Alignments being computed right now, so concurrent requests share one. */
  private readonly aligning = new Map<string, Promise<Alignment | undefined>>();
  /** Base commit and path pairs whose alignment was abandoned, until the file is saved. */
  private readonly farApart = new Set<string>();
  /** Mainline drift for every file, keyed by the base and tip it was computed between. */
  private readonly drift = new Map<string, DriftIndex>();
  /** Pull request diffs being read right now, so concurrent analyses share one. */
  private readonly loading = new Map<string, Promise<void>>();
  /** Which of GitRay's refs exist, read once and reused until something changes them. */
  private refs: Promise<Map<string, string>> | undefined;
  /** Each pull request's paths as a set, so relevance is a lookup rather than a scan. */
  private readonly paths = new WeakMap<PullRequest, ReadonlySet<string>>();

  constructor(
    private readonly git: Git,
    private readonly store: Store,
    /** Which remote the mainline lives on — `origin` is not a safe assumption in a fork. */
    private readonly remotes: RemoteSelector
  ) {}

  /**
   * Drop everything derived from git state. Call when HEAD moves.
   *
   * Base copies are kept: they are keyed by commit, and what a commit contains never
   * changes, so a checkout does not make any of them wrong.
   */
  reset(): void {
    this.mergeBases.clear();
    this.mainlines.clear();
    this.alignments.clear();
    this.farApart.clear();
    this.drift.clear();
    this.refs = undefined;
  }

  /**
   * HEAD moved from one commit to another: keep what the move cannot have changed.
   *
   * A pull request's merge base with HEAD only moves when one of the commits HEAD gained is
   * in that pull request — a merge base is the newest commit both sides have, and the only
   * new commits on your side are the ones you just gained. After a commit or a fast-forward
   * pull that is almost never true, so almost every merge base survives, and with them the
   * regions and alignments computed from them. A commit used to recompute all of it, which
   * in a repository with a hundred open pull requests was a hundred and thirty git processes.
   *
   * Anything that is not a small step forward — a checkout, a rebase, an amend — resets
   * everything, as before.
   */
  async headMoved(from: string | undefined, to: string | undefined): Promise<void> {
    const advanced =
      from !== undefined &&
      to !== undefined &&
      (await this.git.isAncestor(from, to).catch(() => false));
    const gained = advanced ? await this.git.commitsBetween(from, to, MAX_HEAD_ADVANCE) : undefined;
    if (!gained) {
      this.reset();
      return;
    }

    const reached = await this.git.refsContainingAny(gained, GITRAY_NAMESPACE).catch(() => undefined);
    if (!reached) {
      this.reset();
      return;
    }
    for (const head of [...this.mergeBases.keys()]) {
      if (reached.has(head)) this.mergeBases.delete(head);
    }
    // Where your branch left each mainline: one lookup per base branch, so not worth
    // reasoning about.
    this.mainlines.clear();
    this.refs = undefined;
  }

  /**
   * Forget which refs exist. Call after anything fetches or deletes one.
   *
   * The analyzer used to ask git about a pull request's ref before every diff, which made a
   * pull request whose head is not local — ref fetching turned off, a failed fetch — cost a
   * process spawn per file per pass, forever. Now it reads every ref once and trusts that
   * answer until told otherwise.
   */
  refsChanged(): void {
    this.refs = undefined;
  }

  /** Drop cached alignments for one file, e.g. when it was saved or reverted. */
  invalidate(path: string): void {
    for (const key of this.alignments.keys()) {
      if (key.includes(`\0${path}\0`)) this.alignments.delete(key);
    }
    for (const pair of this.farApart) {
      if (pair.endsWith(`\0${path}`)) this.farApart.delete(pair);
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
    const relevant = pullRequests.filter((pr) => this.pathsOf(pr).has(path));

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
      if (!alignment) {
        // Your copy and the base are too far apart to line up in reasonable time.
        degraded = true;
        continue;
      }
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
      const drift = await this.mainlineRegions(
        path,
        options.mainline,
        bufferLines,
        documentVersion,
        options.proximityLines
      );
      if (drift) resolved.push(...drift);
      else degraded = true;
    }

    if (resolved.length > options.maxRegionsPerFile) {
      // A wholesale reformat or generated-file churn can produce thousands of regions.
      // Rendering them all would be noise anyway, so fall back to a file-level signal.
      log.debug(`${path}: ${resolved.length} regions exceeds cap, degrading to file level`);
      return { path, regions: [], degraded: true };
    }

    resolved.sort(
      (a, b) => a.range.start - b.range.start || compareOrigins(a.origin, b.origin)
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
   *
   * Undefined when there was drift to place but the alignment was abandoned.
   */
  private async mainlineRegions(
    path: string,
    mainline: MainlineState,
    bufferLines: string[],
    documentVersion: number,
    proximityLines: number
  ): Promise<ResolvedRegion[] | undefined> {
    if (mainline.tip === mainline.base) return [];

    const regions = await this.driftIndexFor(mainline)(path);
    if (regions.length === 0) return [];

    const alignment = await this.alignmentFor(
      path,
      mainline.base,
      bufferLines,
      documentVersion
    );
    if (!alignment) return undefined;

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
   * The mainline's changes to every file, in the coordinates of where you left it.
   *
   * Read once per range: one diff and one log for the whole of it, rather than a diff and a
   * log per file. Cached against both ends of the range, so the entry falls out on its own
   * when the mainline is fetched forward or HEAD moves, without anything having to
   * invalidate it.
   */
  private driftIndexFor(mainline: MainlineState): DriftIndex {
    const key = `${mainline.base}\0${mainline.tip}`;
    const cached = this.drift.get(key);
    if (cached) return cached;

    const loaded = this.loadDrift(mainline);
    // A failure is not cached: the next pass gets to try again.
    loaded.catch(() => this.drift.delete(key));

    const index: DriftIndex = async (path) => {
      const byPath = await loaded;
      return byPath ? byPath.get(path) ?? [] : this.driftRegionsForPath(path, mainline);
    };

    while (this.drift.size >= MAX_DRIFT_RANGES) {
      const oldest = this.drift.keys().next();
      if (oldest.done) break;
      this.drift.delete(oldest.value);
    }
    this.drift.set(key, index);
    return index;
  }

  /** Undefined when the range was too large to diff at once. */
  private async loadDrift(
    mainline: MainlineState
  ): Promise<Map<string, ChangeRegion[]> | undefined> {
    const [diffs, commits] = await Promise.all([
      this.git.tryDiffRange(mainline.base, mainline.tip, undefined, {
        renames: false,
        maxBuffer: DRIFT_DIFF_MAX_BUFFER
      }),
      this.git.commitsByPath(mainline.base, mainline.tip)
    ]);
    if (!diffs) {
      log.debug('mainline diff too large to read at once; reading drift per file');
      return undefined;
    }

    const byPath = new Map<string, ChangeRegion[]>();
    for (const file of diffs) {
      if (file.isBinary) continue;
      const fileCommits = commits.get(file.path) ?? [];
      const regions = driftRegionsFrom(file, mainline, fileCommits);
      if (regions.length > 0) byPath.set(file.path, regions);
    }
    return byPath;
  }

  /** The one-file form of `loadDrift`, for a range too large to read in one go. */
  private async driftRegionsForPath(
    path: string,
    mainline: MainlineState
  ): Promise<ChangeRegion[]> {
    const [diffs, commits] = await Promise.all([
      this.git.diffRange(mainline.base, mainline.tip, [path]),
      this.git.commitsIn(mainline.base, mainline.tip, path)
    ]);

    const regions: ChangeRegion[] = [];
    for (const file of diffs) {
      if (file.isBinary) continue;
      // A pathspec can still return the pre-rename path; accept either side.
      if (file.path !== path && file.oldPath !== path) continue;
      regions.push(...driftRegionsFrom(file, mainline, commits));
    }
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
    // The same fallback when the mainline copy is too far from yours to line up.
    if (!alignment) return mergeBaseAlignment.localEdits;
    return alignment.bufferEdits.map((range) => mergeBaseAlignment.toBaseRange(range));
  }

  /** Where your branch left the mainline, cached per base branch. */
  private async mainlineFor(baseRefName: string): Promise<string | undefined> {
    if (this.mainlines.has(baseRefName)) return this.mainlines.get(baseRefName);

    const mainline = await this.git.mainlineBase(baseRefName, await this.remotes.name());
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

    // There are two ways to have no merge base, and only one of them is worth remembering.
    //
    // The head not being on disk is transient: it is fetched shortly *after* the pull
    // request list lands, and muting deletes it so unmuting has to fetch it again. Asking
    // git in that window correctly answers "no shared ancestor", and caching that answer
    // is what used to make the gap permanent — this cache is keyed by head oid and cleared
    // only when HEAD moves, so a single unlucky lookup left the file with no indicators
    // for the rest of the session, immune to unmuting or repainting.
    //
    // Histories that genuinely do not meet — a shallow clone, an unrelated branch — are a
    // stable answer, and those are still remembered so the question is asked once.
    if (!(await this.hasRef(pr))) {
      log.debug(`#${pr.number} has not been fetched yet; not caching its missing merge base`);
      return undefined;
    }

    const base = await this.git.mergeBase(prRef(pr.number));
    this.mergeBases.set(key, base);
    if (!base) {
      log.debug(`no merge base for #${pr.number}; skipping line-level analysis`);
    }
    return base;
  }

  /**
   * The commit your edits are measured from, for a pull request.
   *
   * Where your branch left the pull request's base branch, or the merge base when that
   * branch is not known locally — the same commit `ownEdits` compares against. That makes
   * it the one that decides which files count as yours. The pull request's own merge base
   * does not: everything that landed upstream after an old pull request branched would
   * count as your change, which in a busy repository is hundreds of files you never touched.
   */
  async yourBaseFor(pr: PullRequest): Promise<string | undefined> {
    return (await this.mainlineFor(pr.baseRefName)) ?? this.mergeBaseFor(pr);
  }

  /**
   * Read merge bases and diffs for these pull requests ahead of time, a few at once.
   *
   * Analysis asks for them one file at a time, in order, and each is a git process. Asking
   * in parallel up front means the git work overlaps instead of queueing, and the analyses
   * that follow find it cached.
   */
  async warm(pullRequests: readonly PullRequest[], concurrency = WARM_CONCURRENCY): Promise<void> {
    await inParallel(pullRequests, concurrency, async (pr) => {
      const base = await this.mergeBaseFor(pr);
      const first = pr.files[0];
      if (base && first) await this.regionsFor(first.path, pr, base);
    });
  }

  /** Is this pull request's head local? Answered from the ref snapshot. */
  private async hasRef(pr: PullRequest): Promise<boolean> {
    this.refs ??= this.git.refOids(GITRAY_NAMESPACE);
    return (await this.refs).has(prRef(pr.number));
  }

  /**
   * A pull request's changes to one file, in base coordinates.
   *
   * A miss reads the pull request's diff for *every* file it touches and caches them all,
   * so the next file asked about — the collision scan asks about all of them in a row — is
   * already answered.
   */
  private async regionsFor(
    path: string,
    pr: PullRequest,
    baseSha: string
  ): Promise<ChangeRegion[]> {
    const cached = this.store.cachedRegions(path, pr.number, pr.headRefOid, baseSha);
    if (cached) return cached;

    // The same trap as `mergeBaseFor`, and the one that actually bites: with the head not
    // on disk the diff comes back empty because there is nothing to diff against, not
    // because they changed nothing. That empty answer is cached against the head oid, which
    // does not change when the ref is re-fetched — so a pull request muted and unmuted went
    // permanently blank even though its merge base was still cached and correct.
    if (!(await this.hasRef(pr))) return [];

    const key = `${pr.number}\0${pr.headRefOid}\0${baseSha}`;
    let loading = this.loading.get(key);
    if (!loading) {
      loading = this.loadPullRequest(pr, baseSha).finally(() => this.loading.delete(key));
      this.loading.set(key, loading);
    }
    await loading;

    return this.store.cachedRegions(path, pr.number, pr.headRefOid, baseSha) ?? [];
  }

  /** Read one pull request's diff and cache the regions of every file in it. */
  private async loadPullRequest(pr: PullRequest, baseSha: string): Promise<void> {
    const paths = pr.files.map((file) => file.path);
    const pathspec = paths.reduce((total, path) => total + path.length + 1, 0) <= MAX_PATHSPEC_CHARS
      ? paths
      : undefined;
    // No rename pairing, so each path gets exactly what a diff of that path alone would say.
    const diffs = await this.git.tryDiffRange(baseSha, prRef(pr.number), pathspec, {
      renames: false
    });
    // A failed diff is not "they changed nothing"; leaving the cache empty lets it retry.
    if (!diffs) return;

    const byPath = new Map<string, ChangeRegion[]>();
    for (const file of diffs) {
      if (file.isBinary) continue;
      const regions = file.hunks.map((hunk) => ({
        origin: { kind: 'pullRequest' as const, prNumber: pr.number },
        author: pr.author,
        baseSha,
        baseRange: hunk.baseRange,
        kind: hunk.kind,
        removed: hunk.removed,
        added: hunk.added
      }));
      byPath.set(file.path, regions);
      if (file.oldPath && !byPath.has(file.oldPath)) byPath.set(file.oldPath, regions);
    }

    // Every file the pull request lists gets an entry, empty ones included, so a file whose
    // changes are all binary or whitespace-free is not re-diffed on every pass.
    for (const path of new Set([...paths, ...byPath.keys()])) {
      this.store.cacheRegions(path, pr.number, pr.headRefOid, baseSha, byPath.get(path) ?? []);
    }
  }

  /**
   * Alignment between a base commit's copy of the file and the live buffer.
   *
   * Undefined when the two are too far apart to align within the time budget — see
   * `alignLinesAsync`. That verdict is cached too, for this document version, so a file
   * that blew the budget once does not blow it again on every paint.
   */
  private async alignmentFor(
    path: string,
    baseSha: string,
    bufferLines: string[],
    documentVersion: number
  ): Promise<Alignment | undefined> {
    const key = `${baseSha}\0${path}\0${documentVersion}`;
    const cached = lruGet(this.alignments, key);
    if (cached !== undefined) return cached ?? undefined;

    // Typing makes a new version with every pause, and a file rewritten far past the budget
    // does not come back within it a keystroke later. Retrying would spend the whole budget
    // again on each pause, so the verdict holds until the file is saved.
    const pair = `${baseSha}\0${path}`;
    if (this.farApart.has(pair)) return undefined;

    // An alignment can take a while now that it yields, and the scan and the editor often
    // ask for the same one at once. They share it.
    let pending = this.aligning.get(key);
    if (!pending) {
      pending = (async () => {
        const baseLines = await this.baseLines(baseSha, path);
        const alignment = await alignLinesAsync(baseLines, bufferLines);
        if (!alignment) {
          this.farApart.add(pair);
          log.debug(`${path}: too far from ${baseSha.slice(0, 7)} to align; degrading to file level`);
        }
        lruSet(this.alignments, key, alignment ?? TOO_FAR_APART, MAX_ALIGNMENTS);
        return alignment;
      })().finally(() => this.aligning.delete(key));
      this.aligning.set(key, pending);
    }
    return pending;
  }

  private async baseLines(baseSha: string, path: string): Promise<string[]> {
    const key = `${baseSha}\0${path}`;
    const cached = lruGet(this.blobs, key);
    if (cached) return cached;

    const content = await this.git.readFile(baseSha, path);
    // A file the collaborator created does not exist at the merge base. Treating that as
    // an empty file is correct: everything in your copy is then your own local content.
    const lines = content === undefined ? [''] : splitLines(content);

    lruSet(this.blobs, key, lines, MAX_BLOBS);
    return lines;
  }

  private pathsOf(pr: PullRequest): ReadonlySet<string> {
    let paths = this.paths.get(pr);
    if (!paths) {
      paths = new Set(pr.files.map((file) => file.path));
      this.paths.set(pr, paths);
    }
    return paths;
  }
}

/** One file's mainline hunks as regions, all sharing one origin. */
function driftRegionsFrom(
  file: FileDiff,
  mainline: MainlineState,
  commits: readonly MainlineCommit[]
): ChangeRegion[] {
  // One origin object shared by every region in the file: they all describe the same
  // set of commits, and the surfaces read it rather than copying out of it.
  const origin = {
    kind: 'mainline' as const,
    branch: mainline.branch,
    commits
  };
  const author = attributeDrift(commits, mainline.branch);

  return file.hunks.map((hunk) => ({
    origin,
    author,
    baseSha: mainline.base,
    baseRange: hunk.baseRange,
    kind: hunk.kind,
    removed: hunk.removed,
    added: hunk.added
  }));
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

/** Read an entry and mark it as the most recently used. Map iteration order is insertion. */
function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key) as V;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/** Insert an entry, evicting the least recently used ones to stay within `limit`. */
function lruSet<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  cache.delete(key);
  while (cache.size >= limit) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
  cache.set(key, value);
}

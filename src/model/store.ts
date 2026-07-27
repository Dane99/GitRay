/**
 * The single source of truth every surface reads from.
 *
 * The store holds two tiers of knowledge, and the distinction matters:
 *
 *  - The **file-level index** arrives with the pull request list in one request. It is
 *    always available, even offline or with ref fetching turned off, and it is what the
 *    explorer badges, the tree, and the radar are built on.
 *  - **Line-level regions** require the merge base and a local diff, so they are computed
 *    lazily per file and cached against the pull request head. This is what the editor
 *    decorations need.
 *
 * Everything downstream is a projection of this object, and it fires one change event, so
 * the surfaces can never disagree about what is on screen.
 */

import * as vscode from 'vscode';
import type {
  ChangeRegion,
  FileSummary,
  MainlineState,
  PullRequest,
  StatusInfo,
  DegradedReason
} from '../core/types.js';
import { assignHues, MAINLINE_HUE } from './palette.js';

/** Line-level regions for one file from one pull request, keyed to a head commit. */
interface RegionCacheEntry {
  headOid: string;
  baseSha: string;
  regions: ChangeRegion[];
}

export class Store implements vscode.Disposable {
  private pullRequests = new Map<number, PullRequest>();
  private muted = new Map<number, PullRequest>();
  private summaries = new Map<string, FileSummary>();
  private hues = new Map<string, number>();
  private regions = new Map<string, RegionCacheEntry>();
  private mainlineState: MainlineState | undefined;
  private status: StatusInfo = { state: 'idle', pullRequestCount: 0 };

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever anything a surface renders has changed. */
  readonly onDidChange = this.onDidChangeEmitter.event;

  /** Replace the tracked pull request set. Returns the numbers that are no longer open. */
  setPullRequests(pullRequests: readonly PullRequest[]): number[] {
    const previous = new Set(this.pullRequests.keys());
    const next = new Map(pullRequests.map((pr) => [pr.number, pr]));

    // A quiet poll usually returns exactly what we already have. Detecting that here and
    // not firing is what keeps an idle minute idle: every listener repaints on this event,
    // and the collision scanner spawns a git process per pull request when it runs.
    if (samePullRequests(this.pullRequests, next)) {
      this.status = { ...this.status, lastSync: Date.now() };
      return [];
    }

    this.pullRequests = next;

    for (const number of this.pullRequests.keys()) {
      previous.delete(number);
    }
    const closed = [...previous];

    // Drop cached regions belonging to pull requests that closed or moved on.
    for (const [key, entry] of this.regions) {
      const pr = this.pullRequests.get(prNumberFromKey(key));
      if (!pr || pr.headRefOid !== entry.headOid) {
        this.regions.delete(key);
      }
    }

    this.rebuildSummaries();
    this.hues = assignHues(pullRequests.map((pr) => pr.author));
    this.status = {
      ...this.status,
      pullRequestCount: this.pullRequests.size,
      lastSync: Date.now()
    };
    this.onDidChangeEmitter.fire();
    return closed;
  }

  private rebuildSummaries(): void {
    const summaries = new Map<string, FileSummary>();
    for (const pr of this.pullRequests.values()) {
      for (const file of pr.files) {
        const existing = summaries.get(file.path);
        if (existing) {
          existing.prNumbers.push(pr.number);
          if (!existing.authors.includes(pr.author)) existing.authors.push(pr.author);
          existing.additions += file.additions;
          existing.deletions += file.deletions;
        } else {
          summaries.set(file.path, {
            path: file.path,
            prNumbers: [pr.number],
            authors: [pr.author],
            additions: file.additions,
            deletions: file.deletions
          });
        }
      }
    }
    this.summaries = summaries;
  }

  allPullRequests(): PullRequest[] {
    return [...this.pullRequests.values()].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    );
  }

  // --- Muted ---------------------------------------------------------------------------

  /**
   * Remember what mute is currently hiding.
   *
   * The settings only record numbers and logins, which is enough to filter with and far
   * too little to review: `#412` says nothing about whose pull request it is or what it
   * touches. Keeping the filtered-out records here is what lets the tree's Muted section
   * show a title and an author, so the decision to unmute can be made from the row itself.
   *
   * These never reach `summaries`, `hues`, or the region cache — a muted pull request is
   * hidden from every surface except the one that exists to unhide it.
   */
  setMutedPullRequests(pullRequests: readonly PullRequest[]): void {
    const next = new Map(pullRequests.map((pr) => [pr.number, pr]));
    if (samePullRequests(this.muted, next)) return;

    this.muted = next;
    this.onDidChangeEmitter.fire();
  }

  /** The muted pull request with this number, when GitRay has actually seen it. */
  mutedPullRequest(number: number): PullRequest | undefined {
    return this.muted.get(number);
  }

  /** Open pull requests this author's mute is hiding, most recently updated first. */
  mutedPullRequestsBy(author: string): PullRequest[] {
    const wanted = author.toLowerCase();
    return [...this.muted.values()]
      .filter((pr) => pr.author.toLowerCase() === wanted)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  pullRequest(number: number): PullRequest | undefined {
    return this.pullRequests.get(number);
  }

  /** Pull requests touching a repo-relative path, most recently updated first. */
  pullRequestsForPath(path: string): PullRequest[] {
    const summary = this.summaries.get(path);
    if (!summary) return [];
    return summary.prNumbers
      .map((number) => this.pullRequests.get(number))
      .filter((pr): pr is PullRequest => pr !== undefined)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  fileSummary(path: string): FileSummary | undefined {
    return this.summaries.get(path);
  }

  allTouchedPaths(): string[] {
    return [...this.summaries.keys()];
  }

  hueFor(author: string): number {
    return this.hues.get(author) ?? 0;
  }

  /**
   * The hue a region should be drawn in.
   *
   * Origin decides, not the author: mainline drift keeps its reserved slot even when a
   * single person's commit is what landed, so "main moved under you" never gets mistaken
   * for "that person has a pull request open".
   */
  hueForRegion(region: Pick<ChangeRegion, 'origin' | 'author'>): number {
    return region.origin.kind === 'mainline' ? MAINLINE_HUE : this.hueFor(region.author);
  }

  // --- Mainline ------------------------------------------------------------------------

  /**
   * Record where the mainline is.
   *
   * Fires only when the tip or the base actually moved. This runs on every sync pass, and
   * the usual answer is "exactly where it was" — announcing that would repaint every
   * surface and retrigger the collision scan once a minute for nothing.
   */
  setMainline(state: MainlineState | undefined): void {
    const previous = this.mainlineState;
    if (
      previous?.branch === state?.branch &&
      previous?.tip === state?.tip &&
      previous?.base === state?.base
    ) {
      return;
    }

    this.mainlineState = state;
    this.onDidChangeEmitter.fire();
  }

  mainline(): MainlineState | undefined {
    return this.mainlineState;
  }

  /** True when work has landed on the mainline that your branch does not have yet. */
  hasMainlineDrift(): boolean {
    return this.mainlineState !== undefined && this.mainlineState.tip !== this.mainlineState.base;
  }

  // --- Line-level region cache -------------------------------------------------------

  cacheRegions(path: string, prNumber: number, headOid: string, baseSha: string, regions: ChangeRegion[]): void {
    this.regions.set(regionKey(path, prNumber), { headOid, baseSha, regions });
  }

  cachedRegions(path: string, prNumber: number, headOid: string): ChangeRegion[] | undefined {
    const entry = this.regions.get(regionKey(path, prNumber));
    if (!entry || entry.headOid !== headOid) return undefined;
    return entry.regions;
  }

  /**
   * Forget every cached region and tell the surfaces, e.g. after HEAD moved.
   *
   * Firing here matters: a checkout changes every merge base while usually leaving the
   * pull request list identical, so the quiet-poll check in `setPullRequests` would see
   * nothing new and the collision scan would keep rendering coordinates computed against
   * the old HEAD.
   */
  invalidateAll(): void {
    this.regions.clear();
    this.onDidChangeEmitter.fire();
  }

  // --- Status ------------------------------------------------------------------------

  /**
   * Update status, firing only when something actually changed.
   *
   * Surfaces react to `onDidChange` by doing work, and some of that work reports status
   * back here. Without this guard a no-op update becomes a feedback loop that spins
   * forever, so equality is checked before anything is announced.
   */
  setStatus(update: Partial<StatusInfo>): void {
    const next = { ...this.status, ...update };
    if (sameStatus(this.status, next)) return;

    this.status = next;
    this.onDidChangeEmitter.fire();
  }

  setDegraded(reason: DegradedReason, message: string): void {
    this.setStatus({ state: 'degraded', reason, message });
  }

  currentStatus(): StatusInfo {
    return this.status;
  }

  /** Reset to nothing, e.g. when the workspace stops being a GitHub repository. */
  clear(): void {
    this.pullRequests.clear();
    this.muted.clear();
    this.summaries.clear();
    this.regions.clear();
    this.hues.clear();
    this.mainlineState = undefined;
    this.status = { state: 'idle', pullRequestCount: 0 };
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

/**
 * Compare status, ignoring `lastSync`.
 *
 * A sync that finds nothing new still updates its timestamp, and treating that as a
 * change would repaint every surface once a minute for no reason.
 */
function sameStatus(a: StatusInfo, b: StatusInfo): boolean {
  return (
    a.state === b.state &&
    a.reason === b.reason &&
    a.message === b.message &&
    a.pullRequestCount === b.pullRequestCount
  );
}

/**
 * Are these the same pull requests in the same state?
 *
 * `updatedAt` covers everything GitHub knows about — a push, a retitle, a draft flip all
 * bump it — but the files list must be compared too, because it is filtered locally and a
 * changed ignore list alters it without touching the pull request itself.
 */
function samePullRequests(
  a: ReadonlyMap<number, PullRequest>,
  b: ReadonlyMap<number, PullRequest>
): boolean {
  if (a.size !== b.size) return false;
  for (const [number, pr] of a) {
    const other = b.get(number);
    if (!other) return false;
    if (
      pr.headRefOid !== other.headRefOid ||
      pr.updatedAt !== other.updatedAt ||
      pr.title !== other.title ||
      pr.author !== other.author ||
      pr.baseRefName !== other.baseRefName ||
      pr.isDraft !== other.isDraft ||
      pr.files.length !== other.files.length
    ) {
      return false;
    }
    for (let i = 0; i < pr.files.length; i++) {
      const mine = pr.files[i];
      const theirs = other.files[i];
      if (
        mine.path !== theirs.path ||
        mine.additions !== theirs.additions ||
        mine.deletions !== theirs.deletions
      ) {
        return false;
      }
    }
  }
  return true;
}

// Region cache keys embed the pull request number so a single pull request's entries can
// be invalidated without walking every path.
function regionKey(path: string, prNumber: number): string {
  return `${prNumber}\0${path}`;
}

function prNumberFromKey(key: string): number {
  return Number(key.slice(0, key.indexOf('\0')));
}

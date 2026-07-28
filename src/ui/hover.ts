/**
 * The hover card.
 *
 * This is where the ambient signal becomes a full explanation: who, which pull request,
 * what they actually wrote, and — when it matters — how it relates to your own edit. The
 * diff preview is the part that saves a round trip to the browser, so it comes before
 * the links rather than after.
 *
 * Mainline drift gets the same card with a different frame. The question it has to answer
 * is not "who is working here" but "what already landed, and what will my next rebase do
 * about it" — so it leads with the commits rather than with a person, and its verdict
 * speaks in the future tense of the rebase rather than of a merge that may never happen.
 */

import * as vscode from 'vscode';
import type { ChangeRegion, MainlineCommit, PullRequest, ResolvedRegion } from '../core/types.js';

/** Commands the card is allowed to invoke, so the markdown need not be blanket-trusted. */
const ENABLED_COMMANDS = [
  'gitray.openPullRequest',
  'gitray.diffWithPullRequest',
  'gitray.checkoutPullRequest',
  'gitray.mutePullRequest',
  'gitray.diffWithMainline'
];

const MAX_PREVIEW_LINES = 14;
const MAX_LISTED_COMMITS = 5;

export function buildHover(
  regions: readonly ResolvedRegion[],
  pullRequests: ReadonlyMap<number, PullRequest>,
  relativePath: string
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ENABLED_COMMANDS };
  md.supportHtml = false;

  regions.forEach((region, index) => {
    if (index > 0) md.appendMarkdown('\n\n---\n\n');
    if (region.origin.kind === 'mainline') {
      appendMainlineRegion(md, region, relativePath);
    } else {
      appendPullRequestRegion(md, region, pullRequests.get(region.origin.prNumber), relativePath);
    }
  });

  return md;
}

/**
 * Compact "who, and from where" for the surfaces with one line to spend.
 *
 * Mainline drift says `merged` rather than naming a branch: the branch is the same one
 * every time, so repeating it costs characters and tells the reader nothing.
 */
export function regionLabel(region: ChangeRegion): string {
  if (region.origin.kind === 'pullRequest') {
    return `${region.author} #${region.origin.prNumber}`;
  }

  const merged = soleCommit(region.origin.commits);
  return merged?.prNumber
    ? `${region.author} #${merged.prNumber} · merged`
    : `${region.author} · merged`;
}

/** The one-line description a compact surface shows next to the label. */
export function regionHeadline(region: ChangeRegion, pr: PullRequest | undefined): string {
  if (region.origin.kind === 'pullRequest') return pr?.title ?? `#${region.origin.prNumber}`;
  return region.origin.commits[0]?.subject ?? 'landed on the mainline';
}

// --- Pull requests ---------------------------------------------------------------------

function appendPullRequestRegion(
  md: vscode.MarkdownString,
  region: ResolvedRegion,
  pr: PullRequest | undefined,
  relativePath: string
): void {
  const prNumber = region.origin.kind === 'pullRequest' ? region.origin.prNumber : 0;
  const title = pr?.title ?? 'Pull request';
  md.appendMarkdown(`**#${prNumber} · ${escapeMarkdown(title)}**\n\n`);

  const meta: string[] = [`$(account) ${escapeMarkdown(region.author)}`];
  if (pr?.headRefName) meta.push(`$(git-branch) \`${pr.headRefName}\``);
  if (pr?.updatedAt) meta.push(`$(clock) ${relativeTime(pr.updatedAt)}`);
  if (pr?.isDraft) meta.push('$(git-pull-request-draft) draft');
  md.appendMarkdown(`${meta.join(' &nbsp;·&nbsp; ')}\n\n`);

  md.appendMarkdown(`${verdict(region, 'merge')}\n\n`);
  appendPreview(md, region);

  const args = (extra: object = {}) =>
    encodeURIComponent(JSON.stringify([{ prNumber, path: relativePath, ...extra }]));

  const links = [
    // Both of these carry the path, which is what makes them land on this file's diff
    // rather than at the top of the pull request. See githubUrls.ts.
    `[Open PR](command:gitray.openPullRequest?${args()} "Open #${prNumber} on GitHub, at this file's changes")`,
    `[Compare](command:gitray.diffWithPullRequest?${args()} "Diff their version of this file against yours")`,
    `[Check out](command:gitray.checkoutPullRequest?${args()} "Check out this branch locally")`,
    `[Mute](command:gitray.mutePullRequest?${args()} "Stop showing this pull request")`
  ];
  md.appendMarkdown(links.join(' &nbsp;·&nbsp; '));
}

// --- Mainline drift --------------------------------------------------------------------

function appendMainlineRegion(
  md: vscode.MarkdownString,
  region: ResolvedRegion,
  relativePath: string
): void {
  if (region.origin.kind !== 'mainline') return;
  const { branch, commits } = region.origin;

  md.appendMarkdown(`**\`${codeSpan(branch)}\` has moved under you**\n\n`);

  const meta: string[] = [
    `$(git-merge) ${commits.length || 'some'} ${commits.length === 1 ? 'commit' : 'commits'} landed here`
  ];
  if (commits[0]?.date) meta.push(`$(clock) ${relativeTime(commits[0].date)}`);
  md.appendMarkdown(`${meta.join(' &nbsp;·&nbsp; ')}\n\n`);

  md.appendMarkdown(`${verdict(region, 'rebase')}\n\n`);
  appendPreview(md, region);
  appendCommits(md, commits);

  const args = encodeURIComponent(JSON.stringify([{ path: relativePath }]));
  const links = [
    `[Compare](command:gitray.diffWithMainline?${args} "Diff the mainline's version of this file against yours")`
  ];

  // Only offer the pull request link when the merge actually left a number behind; a
  // fabricated one would open somebody else's discussion.
  const merged = soleCommit(commits);
  if (merged?.prNumber) {
    const prArgs = encodeURIComponent(
      JSON.stringify([{ prNumber: merged.prNumber, path: relativePath }])
    );
    links.unshift(
      `[Open #${merged.prNumber}](command:gitray.openPullRequest?${prArgs} "Open the pull request this came from, at this file's changes")`
    );
  }

  md.appendMarkdown(links.join(' &nbsp;·&nbsp; '));
}

/** The commits behind this drift, newest first. */
function appendCommits(md: vscode.MarkdownString, commits: readonly MainlineCommit[]): void {
  if (commits.length === 0) return;

  for (const commit of commits.slice(0, MAX_LISTED_COMMITS)) {
    const when = commit.date ? ` · ${relativeTime(commit.date)}` : '';
    md.appendMarkdown(
      `- \`${commit.sha}\` ${escapeMarkdown(commit.subject)} — ${escapeMarkdown(commit.author)}${when}\n`
    );
  }

  const rest = commits.length - MAX_LISTED_COMMITS;
  if (rest > 0) md.appendMarkdown(`- … ${rest} more\n`);
  md.appendMarkdown('\n');
}

// --- Shared --------------------------------------------------------------------------

/**
 * One line saying what this means for you.
 *
 * The tense is the difference that matters. A pull request *would* conflict if it merges,
 * and it may yet move. Something already on the mainline *will* meet you at your next
 * rebase, whatever anyone does from here.
 */
function verdict(region: ResolvedRegion, resolution: 'merge' | 'rebase'): string {
  const settle =
    resolution === 'merge' ? 'Merging will need a decision.' : 'Your next rebase will stop here.';

  switch (region.severity) {
    case 'collision': {
      const where = region.overlapsWith ? ` at ${describeRange(region.overlapsWith)}` : '';
      return `$(warning) **This overlaps your own edit${where}.** ${settle}`;
    }
    case 'nearMiss': {
      const lines = region.distance === 1 ? 'line' : 'lines';
      return `$(info) ${region.distance} ${lines} from your nearest edit.`;
    }
    default:
      return `$(circle-small-filled) ${describeKind(region)} — no conflict with your work.`;
  }
}

function describeKind(region: ResolvedRegion): string {
  const added = region.added.length;
  const removed = region.removed.length;
  switch (region.kind) {
    case 'add':
      return `Added ${added} ${added === 1 ? 'line' : 'lines'}`;
    case 'delete':
      return `Removed ${removed} ${removed === 1 ? 'line' : 'lines'}`;
    default:
      return `Changed ${removed} ${removed === 1 ? 'line' : 'lines'}`;
  }
}

/**
 * Show the change as a diff.
 *
 * Fenced as `diff` rather than the file's own language so the +/- markers get colored,
 * which is what makes a small change readable at a glance. Long hunks are trimmed from
 * the middle: the start and end carry the meaning, the bulk rarely does.
 */
function appendPreview(md: vscode.MarkdownString, region: ResolvedRegion): void {
  const lines = [
    ...region.removed.map((line) => `-${line}`),
    ...region.added.map((line) => `+${line}`)
  ];

  if (lines.length === 0) return;

  const shown =
    lines.length <= MAX_PREVIEW_LINES
      ? lines
      : [
          ...lines.slice(0, MAX_PREVIEW_LINES - 4),
          `  … ${lines.length - MAX_PREVIEW_LINES + 4} more lines …`,
          ...lines.slice(-3)
        ];

  md.appendCodeblock(shown.join('\n'), 'diff');
  md.appendMarkdown('\n');
}

/**
 * The single commit responsible for a change, when there is one.
 *
 * With several commits in the range there is no honest way to say which one produced a
 * given line without a blame pass, so callers that need attribution get nothing rather
 * than a guess.
 */
function soleCommit(commits: readonly MainlineCommit[]): MainlineCommit | undefined {
  return commits.length === 1 ? commits[0] : undefined;
}

function describeRange(range: { start: number; end: number }): string {
  if (range.start === range.end) return `line ${range.start + 1}`;
  if (range.end - range.start === 1) return `line ${range.start + 1}`;
  return `lines ${range.start + 1}–${range.end}`;
}

export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'recently';

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;

  return `${Math.round(days / 30)}mo ago`;
}

/** Escape the markdown that shows up in real pull request titles and commit subjects. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

/**
 * Make text safe to put *inside* a code span, which is a different job from escaping it.
 *
 * Markdown does not process backslash escapes inside backticks, so running a branch name
 * through `escapeMarkdown` there renders the backslashes literally — `feat/my-thing` comes
 * out as `feat\-thing`. A backtick is the only character that can break out of the span,
 * so dropping it is both necessary and sufficient.
 */
export function codeSpan(text: string): string {
  return text.replace(/`/g, '');
}

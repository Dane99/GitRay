/**
 * The hover card.
 *
 * This is where the ambient signal becomes a full explanation: who, which pull request,
 * what they actually wrote, and — when it matters — how it relates to your own edit. The
 * diff preview is the part that saves a round trip to the browser, so it comes before
 * the links rather than after.
 */

import * as vscode from 'vscode';
import type { PullRequest, ResolvedRegion } from '../core/types.js';

/** Commands the card is allowed to invoke, so the markdown need not be blanket-trusted. */
const ENABLED_COMMANDS = [
  'gitray.openPullRequest',
  'gitray.diffWithPullRequest',
  'gitray.checkoutPullRequest',
  'gitray.mutePullRequest'
];

const MAX_PREVIEW_LINES = 14;

export function buildHover(
  regions: readonly ResolvedRegion[],
  pullRequests: ReadonlyMap<number, PullRequest>,
  languageId: string,
  relativePath: string
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ENABLED_COMMANDS };
  md.supportHtml = false;

  regions.forEach((region, index) => {
    if (index > 0) md.appendMarkdown('\n\n---\n\n');
    appendRegion(md, region, pullRequests.get(region.prNumber), languageId, relativePath);
  });

  return md;
}

function appendRegion(
  md: vscode.MarkdownString,
  region: ResolvedRegion,
  pr: PullRequest | undefined,
  languageId: string,
  relativePath: string
): void {
  const title = pr?.title ?? 'Pull request';
  md.appendMarkdown(`**#${region.prNumber} · ${escapeMarkdown(title)}**\n\n`);

  const meta: string[] = [`$(account) ${escapeMarkdown(region.author)}`];
  if (pr?.headRefName) meta.push(`$(git-branch) \`${pr.headRefName}\``);
  if (pr?.updatedAt) meta.push(`$(clock) ${relativeTime(pr.updatedAt)}`);
  if (pr?.isDraft) meta.push('$(git-pull-request-draft) draft');
  md.appendMarkdown(`${meta.join(' &nbsp;·&nbsp; ')}\n\n`);

  md.appendMarkdown(`${verdict(region)}\n\n`);
  appendPreview(md, region, languageId);

  const args = (extra: object = {}) =>
    encodeURIComponent(JSON.stringify([{ prNumber: region.prNumber, path: relativePath, ...extra }]));

  const links = [
    `[Open PR](command:gitray.openPullRequest?${args()} "Open #${region.prNumber} on GitHub")`,
    `[Compare](command:gitray.diffWithPullRequest?${args()} "Diff their version of this file against yours")`,
    `[Check out](command:gitray.checkoutPullRequest?${args()} "Check out this branch locally")`,
    `[Mute](command:gitray.mutePullRequest?${args()} "Stop showing this pull request")`
  ];
  md.appendMarkdown(links.join(' &nbsp;·&nbsp; '));
}

/** One line saying what this means for you. */
function verdict(region: ResolvedRegion): string {
  switch (region.severity) {
    case 'collision': {
      const where = region.overlapsWith
        ? ` at ${describeRange(region.overlapsWith)}`
        : '';
      return `$(warning) **This overlaps your own edit${where}.** Merging will need a decision.`;
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
function appendPreview(md: vscode.MarkdownString, region: ResolvedRegion, languageId: string): void {
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

  md.appendCodeblock(shown.join('\n'), lines.length > 0 ? 'diff' : languageId);
  md.appendMarkdown('\n');
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

/** Escape the markdown that shows up in real pull request titles. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

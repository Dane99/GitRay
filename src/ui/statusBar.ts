/**
 * Status bar summary.
 *
 * Stays neutral almost always, and takes a warning background only when something
 * actually overlaps your work — the one state where interrupting is justified.
 *
 * The counts are the whole window's, not one repository's. There is only ever one status
 * bar item, and a number that silently covered a single folder of a multi-root workspace
 * would be the most misleading thing on screen: the tooltip breaks it down per repository
 * so the total can always be traced back to where it came from.
 */

import * as vscode from 'vscode';
import { behindMainline } from '../core/types.js';
import type { RepositorySession } from '../session.js';
import type { Workspace } from '../workspace.js';
import { codeSpan, escapeMarkdown, relativeTime } from './hover.js';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly workspace: Workspace) {
    this.item = vscode.window.createStatusBarItem('gitray.status', vscode.StatusBarAlignment.Right, 90);
    this.item.name = 'GitRay';
    this.item.command = 'gitray.openRadar';

    this.disposables.push(this.item, this.workspace.onDidChange(() => this.render()));

    this.render();
  }

  private render(): void {
    const sessions = this.workspace.all();
    if (sessions.length === 0) {
      this.item.hide();
      return;
    }

    // One repository failing is worth saying; the rest still working is worth not hiding.
    // With everything degraded there is no count to show at all, so that is its own state.
    const degraded = sessions.filter((session) => {
      const state = session.store.currentStatus().state;
      return state === 'degraded' || state === 'error';
    });

    if (degraded.length === sessions.length) {
      this.item.text = '$(radio-tower) GitRay';
      this.item.tooltip = new vscode.MarkdownString(
        ['**GitRay**', '', ...degraded.map((session) => this.degradedLine(session))].join('\n')
      );
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    const pullRequests = sessions.flatMap((session) => session.store.allPullRequests());
    const collisions = this.workspace.collisionCount();
    const behind = sessions
      .map((session) => behindMainline(session.store.mainline()))
      .reduce(
        (total, one) => ({
          count: total.count + one.count,
          capped: total.capped || one.capped,
          display: ''
        }),
        { count: 0, capped: false, display: '' }
      );
    const behindDisplay = `${behind.count}${behind.capped ? '+' : ''}`;

    if (pullRequests.length === 0 && behind.count === 0 && degraded.length === 0) {
      // Nothing open and nothing landed means nothing to say. Hiding beats showing a zero.
      // A degraded repository is never nothing to say, though: with a quiet healthy folder
      // next to a broken one, hiding on the counts alone would take the only report of the
      // breakage off screen — and a single degraded repository has always shown something.
      this.item.hide();
      return;
    }

    // The counts read left to right as "open · behind · colliding", and any of the three
    // can be absent. Showing a zero for one of them would make the other two harder to read.
    const parts = ['$(radio-tower)'];
    if (pullRequests.length > 0) parts.push(String(pullRequests.length));
    if (behind.count > 0) parts.push(`$(git-merge) ${behindDisplay}`);
    if (collisions > 0) parts.push(`⟂ ${collisions}`);
    // Reachable only when the item is up for a degraded repository alone: a bare icon with
    // no number beside it would be unreadable, so it falls back to the name.
    if (parts.length === 1) parts.push('GitRay');
    this.item.text = parts.join(' ');

    this.item.backgroundColor =
      collisions > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

    const authors = new Set(pullRequests.map((pr) => pr.author));
    const lines = [
      '**GitRay**',
      '',
      pullRequests.length > 0
        ? `${pullRequests.length} open pull ${pullRequests.length === 1 ? 'request' : 'requests'} from ${authors.size} ${authors.size === 1 ? 'collaborator' : 'collaborators'}`
        : 'No open pull requests',
      behind.count > 0 ? `\n${this.behindLine(sessions)}` : '',
      collisions > 0
        ? `\n$(warning) **${collisions} ${collisions === 1 ? 'collision' : 'collisions'}** with your current work`
        : '\nNo overlap with your current work',
      ...(sessions.length > 1 ? ['', ...sessions.map((session) => this.repositoryLine(session))] : []),
      ...degraded.map((session) => `\n${this.degradedLine(session)}`),
      this.lastSyncLine(sessions)
    ];

    const tooltip = new vscode.MarkdownString(lines.join('\n'), true);
    tooltip.isTrusted = false;
    this.item.tooltip = tooltip;
    this.item.show();
  }

  /**
   * How far behind the mainline you are.
   *
   * Named branches only make sense one repository at a time, so with several attached the
   * line counts repositories instead of pretending they share a `main`.
   */
  private behindLine(sessions: readonly RepositorySession[]): string {
    const drifting = sessions.filter((session) => behindMainline(session.store.mainline()).count > 0);

    if (drifting.length === 1) {
      const mainline = drifting[0].store.mainline();
      const behind = behindMainline(mainline);
      const noun = behind.count === 1 && !behind.capped ? 'commit' : 'commits';
      const where = sessions.length > 1 ? ` in ${escapeMarkdown(drifting[0].label)}` : '';
      return `\`${codeSpan(mainline?.branch ?? 'main')}\`${where} is ${behind.capped ? 'more than ' : ''}${behind.count} ${noun} ahead of where your branch left it`;
    }

    return `${drifting.length} repositories have moved on since your branches left them`;
  }

  /** One repository's contribution to the totals above. */
  private repositoryLine(session: RepositorySession): string {
    const open = session.store.allPullRequests().length;
    const collisions = session.scanner.collisionCount();
    const behind = behindMainline(session.store.mainline());

    const parts: string[] = [];
    if (open > 0) parts.push(`${open} open`);
    if (behind.count > 0) parts.push(`${behind.display} behind`);
    if (collisions > 0) parts.push(`${collisions} colliding`);

    return `- ${escapeMarkdown(session.label)} — ${parts.join(', ') || 'quiet'}`;
  }

  private degradedLine(session: RepositorySession): string {
    const status = session.store.currentStatus();
    const message = status.message ?? 'Unavailable';
    return this.workspace.size > 1
      ? `${escapeMarkdown(session.label)}: ${message}`
      : message;
  }

  /** The oldest sync across the window, because that is the one that says how stale this is. */
  private lastSyncLine(sessions: readonly RepositorySession[]): string {
    const times = sessions
      .map((session) => session.store.currentStatus().lastSync)
      .filter((value): value is number => value !== undefined);
    if (times.length === 0) return '';
    return `\n_Synced ${relativeTime(new Date(Math.min(...times)).toISOString())}_`;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
  }
}

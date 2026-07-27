/**
 * Status bar summary.
 *
 * Stays neutral almost always, and takes a warning background only when something
 * actually overlaps your work — the one state where interrupting is justified.
 */

import * as vscode from 'vscode';
import type { Store } from '../model/store.js';
import type { CollisionScanner } from '../sync/scanner.js';
import { relativeTime } from './hover.js';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: Store,
    private readonly scanner: CollisionScanner
  ) {
    this.item = vscode.window.createStatusBarItem('gitray.status', vscode.StatusBarAlignment.Right, 90);
    this.item.name = 'GitRay';
    this.item.command = 'gitray.openRadar';

    this.disposables.push(
      this.item,
      this.store.onDidChange(() => this.render()),
      this.scanner.onDidChange(() => this.render())
    );

    this.render();
  }

  private render(): void {
    const status = this.store.currentStatus();
    const pullRequests = this.store.allPullRequests();
    const collisions = this.scanner.collisionCount();

    if (status.state === 'degraded' || status.state === 'error') {
      this.item.text = '$(radio-tower) GitRay';
      this.item.tooltip = new vscode.MarkdownString(
        `**GitRay**\n\n${status.message ?? 'Unavailable'}`
      );
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    if (pullRequests.length === 0) {
      // Nothing open means nothing to say. Hiding beats showing a zero.
      this.item.hide();
      return;
    }

    this.item.text =
      collisions > 0
        ? `$(radio-tower) ${pullRequests.length} · ⟂ ${collisions}`
        : `$(radio-tower) ${pullRequests.length}`;

    this.item.backgroundColor =
      collisions > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

    const authors = new Set(pullRequests.map((pr) => pr.author));
    const lines = [
      '**GitRay**',
      '',
      `${pullRequests.length} open pull ${pullRequests.length === 1 ? 'request' : 'requests'} from ${authors.size} ${authors.size === 1 ? 'collaborator' : 'collaborators'}`,
      collisions > 0
        ? `\n$(warning) **${collisions} ${collisions === 1 ? 'collision' : 'collisions'}** with your current work`
        : '\nNo overlap with your current work',
      status.lastSync ? `\n_Synced ${relativeTime(new Date(status.lastSync).toISOString())}_` : ''
    ];

    const tooltip = new vscode.MarkdownString(lines.join('\n'), true);
    tooltip.isTrusted = false;
    this.item.tooltip = tooltip;
    this.item.show();
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
  }
}

/**
 * The GitRay sidebar.
 *
 * Ordered by what deserves attention: anything colliding with your work first, then the
 * open pull requests as ambient context. The collisions section disappears entirely when
 * there is nothing in it — an empty "Collisions (0)" header trains people to ignore the
 * one thing this view exists to surface.
 */

import * as vscode from 'vscode';
import type { FileAnalysis, PullRequest, ResolvedRegion } from '../core/types.js';
import type { Store } from '../model/store.js';
import type { CollisionScanner } from '../sync/scanner.js';
import type { Repository } from '../providers/repository.js';
import { hueColorId } from '../model/palette.js';
import { relativeTime } from './hover.js';

/**
 * Which welcome content the view should show when it has no rows.
 *
 * `starting` only covers the window before the first sync lands. Everything after that is
 * either `content` or a genuine `empty`, so the startup message can never be the last
 * thing a working install shows.
 */
type ViewState = 'starting' | 'empty' | 'content';

type Node =
  | { kind: 'status' }
  | { kind: 'collisionsHeader' }
  | { kind: 'collisionFile'; analysis: FileAnalysis }
  | { kind: 'collisionRegion'; analysis: FileAnalysis; region: ResolvedRegion }
  | { kind: 'pullRequestsHeader' }
  | { kind: 'pullRequest'; pr: PullRequest }
  | { kind: 'pullRequestFile'; pr: PullRequest; path: string; additions: number; deletions: number };

export class PulseTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private disposables: vscode.Disposable[] = [];
  private viewState: ViewState | undefined;

  constructor(
    private readonly repository: Repository,
    private readonly store: Store,
    private readonly scanner: CollisionScanner
  ) {
    this.disposables.push(
      this.onDidChangeTreeDataEmitter,
      this.store.onDidChange(() => this.refresh()),
      this.scanner.onDidChange(() => this.refresh())
    );
    this.publishViewState();
  }

  refresh(): void {
    this.publishViewState();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  /**
   * Keep `gitray.view` in step with what the tree actually renders.
   *
   * A tree with no rows falls through to the view's welcome content, and that content is
   * static markdown only the editor can swap — the extension cannot rewrite it. Without
   * this key the startup message is the only thing the view can ever say, so a repository
   * with nothing to track looks permanently stuck mid-launch.
   *
   * Deriving the state from `roots()` rather than from status alone is deliberate: it is
   * the same call that produces the rows, so the welcome content and the tree cannot
   * disagree about whether the view is empty.
   */
  private publishViewState(): void {
    const state: ViewState =
      this.roots().length > 0
        ? 'content'
        : this.store.currentStatus().lastSync === undefined
          ? 'starting'
          : 'empty';

    if (state === this.viewState) return;
    this.viewState = state;
    void vscode.commands.executeCommand('setContext', 'gitray.view', state);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'status':
        return this.statusItem();
      case 'collisionsHeader':
        return this.collisionsHeaderItem();
      case 'collisionFile':
        return this.collisionFileItem(node.analysis);
      case 'collisionRegion':
        return this.collisionRegionItem(node.analysis, node.region);
      case 'pullRequestsHeader':
        return this.pullRequestsHeaderItem();
      case 'pullRequest':
        return this.pullRequestItem(node.pr);
      case 'pullRequestFile':
        return this.pullRequestFileItem(node);
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.roots();

    switch (node.kind) {
      case 'collisionsHeader':
        return this.scanner.hotFiles().map((analysis) => ({ kind: 'collisionFile', analysis }));

      case 'collisionFile':
        return node.analysis.regions
          .filter((region) => region.severity !== 'ambient')
          .map((region) => ({ kind: 'collisionRegion', analysis: node.analysis, region }));

      case 'pullRequestsHeader':
        return this.store.allPullRequests().map((pr) => ({ kind: 'pullRequest', pr }));

      case 'pullRequest':
        return node.pr.files
          .slice()
          .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
          .map((file) => ({
            kind: 'pullRequestFile',
            pr: node.pr,
            path: file.path,
            additions: file.additions,
            deletions: file.deletions
          }));

      default:
        return [];
    }
  }

  private roots(): Node[] {
    const nodes: Node[] = [];
    const status = this.store.currentStatus();

    if (status.state === 'degraded' || status.state === 'error') {
      nodes.push({ kind: 'status' });
    }
    if (this.scanner.hotFiles().length > 0) {
      nodes.push({ kind: 'collisionsHeader' });
    }
    if (this.store.allPullRequests().length > 0) {
      nodes.push({ kind: 'pullRequestsHeader' });
    }

    return nodes;
  }

  // --- Item construction ---------------------------------------------------------------

  /**
   * The degraded-state row.
   *
   * Deliberately a tree row rather than a notification: the reasons here (gh not
   * installed, not authenticated, shallow clone) are persistent conditions, and a modal
   * that reappears every poll would be worse than the missing feature.
   */
  private statusItem(): vscode.TreeItem {
    const status = this.store.currentStatus();
    const item = new vscode.TreeItem(
      status.message ?? 'GitRay is not fully available',
      vscode.TreeItemCollapsibleState.None
    );
    item.iconPath = new vscode.ThemeIcon(
      status.state === 'error' ? 'error' : 'info',
      new vscode.ThemeColor(
        status.state === 'error' ? 'problemsErrorIcon.foreground' : 'problemsWarningIcon.foreground'
      )
    );
    item.tooltip = status.message;
    item.contextValue = 'gitray.status';

    if (status.reason === 'gh-unauthenticated') {
      item.command = {
        command: 'gitray.showOutput',
        title: 'Show log'
      };
    }
    return item;
  }

  private collisionsHeaderItem(): vscode.TreeItem {
    const files = this.scanner.hotFiles();
    const collisions = this.scanner.collisionCount();

    const item = new vscode.TreeItem('Collisions', vscode.TreeItemCollapsibleState.Expanded);
    item.description =
      collisions > 0
        ? `${collisions} in ${files.length} ${files.length === 1 ? 'file' : 'files'}`
        : `${files.length} nearby`;
    item.iconPath = new vscode.ThemeIcon(
      collisions > 0 ? 'warning' : 'info',
      new vscode.ThemeColor(collisions > 0 ? 'gitray.collisionForeground' : 'gitray.nearMissForeground')
    );
    item.tooltip = new vscode.MarkdownString(
      'Files where your work and a collaborator\'s overlap.\n\nComputed against the merge base, the same way git decides whether a merge conflicts.'
    );
    item.contextValue = 'gitray.collisions';
    return item;
  }

  private collisionFileItem(analysis: FileAnalysis): vscode.TreeItem {
    const uri = this.repository.uriFor(analysis.path);
    const collisions = analysis.regions.filter((r) => r.severity === 'collision').length;
    const nearMisses = analysis.regions.filter((r) => r.severity === 'nearMiss').length;

    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.Expanded);
    item.description = collisions > 0 ? `⟂ ${collisions}` : `${nearMisses} nearby`;
    item.resourceUri = uri;
    item.contextValue = 'gitray.file';
    item.tooltip = analysis.path;
    return item;
  }

  private collisionRegionItem(analysis: FileAnalysis, region: ResolvedRegion): vscode.TreeItem {
    const pr = this.store.pullRequest(region.prNumber);
    const line = region.range.start + 1;

    const item = new vscode.TreeItem(
      `${region.author} · #${region.prNumber}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.description =
      region.severity === 'collision'
        ? `line ${line} · overlaps yours`
        : `line ${line} · ${region.distance} away`;
    item.iconPath = new vscode.ThemeIcon(
      region.severity === 'collision' ? 'circle-filled' : 'circle-outline',
      new vscode.ThemeColor(hueColorId(this.store.hueFor(region.author)))
    );
    item.tooltip = new vscode.MarkdownString(
      `**${pr?.title ?? `#${region.prNumber}`}**\n\n${analysis.path}:${line}`
    );
    item.command = {
      command: 'gitray.revealRegion',
      title: 'Reveal',
      arguments: [{ path: analysis.path, line: region.range.start }]
    };
    item.contextValue = 'gitray.region';
    return item;
  }

  private pullRequestsHeaderItem(): vscode.TreeItem {
    const pullRequests = this.store.allPullRequests();
    const authors = new Set(pullRequests.map((pr) => pr.author));

    const item = new vscode.TreeItem('Active pull requests', vscode.TreeItemCollapsibleState.Expanded);
    item.description = `${pullRequests.length} · ${authors.size} ${authors.size === 1 ? 'author' : 'authors'}`;
    item.iconPath = new vscode.ThemeIcon('git-pull-request');
    item.contextValue = 'gitray.pullRequests';
    return item;
  }

  private pullRequestItem(pr: PullRequest): vscode.TreeItem {
    const item = new vscode.TreeItem(pr.title, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = `#${pr.number} · ${pr.author} · ${relativeTime(pr.updatedAt)}`;
    item.iconPath = new vscode.ThemeIcon(
      pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request',
      new vscode.ThemeColor(hueColorId(this.store.hueFor(pr.author)))
    );
    item.tooltip = new vscode.MarkdownString(
      [
        `**#${pr.number} · ${pr.title}**`,
        '',
        `${pr.author} · \`${pr.headRefName}\` → \`${pr.baseRefName}\``,
        '',
        `+${pr.additions} −${pr.deletions} across ${pr.files.length} ${pr.files.length === 1 ? 'file' : 'files'}`,
        '',
        `Updated ${relativeTime(pr.updatedAt)}`
      ].join('\n')
    );
    item.contextValue = 'gitray.pr';
    return item;
  }

  private pullRequestFileItem(node: {
    pr: PullRequest;
    path: string;
    additions: number;
    deletions: number;
  }): vscode.TreeItem {
    const uri = this.repository.uriFor(node.path);
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    item.description = `+${node.additions} −${node.deletions}`;
    item.resourceUri = uri;
    item.tooltip = node.path;
    item.contextValue = 'gitray.file';
    item.command = {
      command: 'gitray.diffWithPullRequest',
      title: 'Compare',
      arguments: [{ prNumber: node.pr.number, path: node.path }]
    };
    return item;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
  }
}

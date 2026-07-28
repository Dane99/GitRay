/**
 * The GitRay sidebar.
 *
 * Ordered by what deserves attention: what has already landed on the mainline, then
 * anything colliding with your work, then the open pull requests as ambient context. The
 * collisions section disappears entirely when there is nothing in it — an empty
 * "Collisions (0)" header trains people to ignore the one thing this view exists to
 * surface.
 *
 * Muted work sits last, collapsed, and only when there is something in it. It is the
 * inverse of everything above — a list of what GitRay has been told *not* to say — so it
 * gets the least attention a section can get while still existing. It has to exist,
 * though: muting is one click and, without somewhere to see the result, taking it back
 * meant hand-editing settings.json.
 *
 * With more than one repository attached, that whole arrangement moves down a level and
 * each repository gets a row of its own. A single repository keeps the flat shape, because
 * a tree with one permanently-expanded root node is a wasted indent.
 */

import * as vscode from 'vscode';
import type { FileAnalysis, PullRequest, ResolvedRegion } from '../core/types.js';
import { behindMainline, prNumberOf } from '../core/types.js';
import type { RepositorySession } from '../session.js';
import type { Workspace } from '../workspace.js';
import { hueColorId } from '../model/palette.js';
import { codeSpan, escapeMarkdown, regionHeadline, relativeTime } from './hover.js';

/**
 * Which welcome content the view should show when it has no rows.
 *
 * `starting` only covers the window before the first sync lands. Everything after that is
 * either `content` or a genuine `empty`, so the startup message can never be the last
 * thing a working install shows.
 */
type ViewState = 'starting' | 'empty' | 'noRepo' | 'content';

/**
 * Every row knows which repository it came from.
 *
 * Not a convenience: it is what the commands read to act on the right repository when a
 * context menu is used, and without it a menu item clicked in one folder would quietly
 * run against another.
 */
type Node = { session: RepositorySession } & (
  | { kind: 'repository' }
  | { kind: 'status' }
  | { kind: 'mainline' }
  | { kind: 'collisionsHeader' }
  | { kind: 'collisionFile'; analysis: FileAnalysis }
  | { kind: 'collisionRegion'; analysis: FileAnalysis; region: ResolvedRegion }
  | { kind: 'pullRequestsHeader' }
  | { kind: 'pullRequest'; pr: PullRequest }
  | { kind: 'pullRequestFile'; pr: PullRequest; path: string; additions: number; deletions: number }
  | { kind: 'mutedHeader' }
  // `prNumber` and `author` are named to match what the commands read off a context-menu
  // argument, so the inline unmute buttons act on the row they were clicked from.
  | { kind: 'mutedPullRequest'; prNumber: number; pr: PullRequest | undefined }
  | { kind: 'mutedAuthor'; author: string; hiding: number }
);

export class PulseTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private disposables: vscode.Disposable[] = [];
  private viewState: ViewState | undefined;

  constructor(private readonly workspace: Workspace) {
    this.disposables.push(
      this.onDidChangeTreeDataEmitter,
      this.workspace.onDidChange(() => this.refresh()),
      // The Muted section reads the settings directly, so it is the one part of this view
      // that can change without the store changing — someone editing settings.json by hand,
      // or a mute applied while gh is unreachable and no sync is landing.
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('gitray')) this.refresh();
      })
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
    const state = this.currentViewState();
    if (state === this.viewState) return;
    this.viewState = state;
    void vscode.commands.executeCommand('setContext', 'gitray.view', state);
  }

  private currentViewState(): ViewState {
    // Probing a folder costs a git subprocess, and "we have not looked yet" must not be
    // shown as "there is nothing here" for however long that takes.
    if (!this.workspace.ready) return 'starting';

    const sessions = this.workspace.all();
    if (sessions.length === 0) return 'noRepo';
    if (this.roots().length > 0) return 'content';

    return sessions.every((session) => session.store.currentStatus().lastSync !== undefined)
      ? 'empty'
      : 'starting';
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'repository':
        return this.repositoryItem(node.session);
      case 'status':
        return this.statusItem(node.session);
      case 'mainline':
        return this.mainlineItem(node.session);
      case 'collisionsHeader':
        return this.collisionsHeaderItem(node.session);
      case 'collisionFile':
        return this.collisionFileItem(node.session, node.analysis);
      case 'collisionRegion':
        return this.collisionRegionItem(node.session, node.analysis, node.region);
      case 'pullRequestsHeader':
        return this.pullRequestsHeaderItem(node.session);
      case 'pullRequest':
        return this.pullRequestItem(node.session, node.pr);
      case 'pullRequestFile':
        return this.pullRequestFileItem(node.session, node);
      case 'mutedHeader':
        return this.mutedHeaderItem(node.session);
      case 'mutedPullRequest':
        return this.mutedPullRequestItem(node.prNumber, node.pr);
      case 'mutedAuthor':
        return this.mutedAuthorItem(node.author, node.hiding);
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.roots();
    const { session } = node;

    switch (node.kind) {
      case 'repository':
        return this.sections(session);

      case 'collisionsHeader':
        return session.scanner
          .hotFiles()
          .map((analysis) => ({ kind: 'collisionFile', session, analysis }));

      case 'collisionFile':
        return node.analysis.regions
          .filter((region) => region.severity !== 'ambient')
          .map((region) => ({
            kind: 'collisionRegion',
            session,
            analysis: node.analysis,
            region
          }));

      case 'pullRequestsHeader':
        return session.store.allPullRequests().map((pr) => ({ kind: 'pullRequest', session, pr }));

      case 'pullRequest':
        return node.pr.files
          .slice()
          .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
          .map((file) => ({
            kind: 'pullRequestFile',
            session,
            pr: node.pr,
            path: file.path,
            additions: file.additions,
            deletions: file.deletions
          }));

      case 'mutedHeader':
        return this.mutedNodes(session);

      default:
        return [];
    }
  }

  /**
   * What mute is currently hiding, authors before individual pull requests.
   *
   * Built from the settings rather than from the store, because the settings are what mute
   * actually is: a number stays muted after its pull request merges, and an author stays
   * muted while they have nothing open. Both would vanish from a store-derived list and
   * silently keep filtering. The store is consulted only to put a title and a face to the
   * rows it happens to know about.
   */
  private mutedNodes(session: RepositorySession): Node[] {
    const config = session.config();

    const authors: Node[] = config.mutedAuthors.map((author) => ({
      kind: 'mutedAuthor',
      session,
      author,
      hiding: session.store.mutedPullRequestsBy(author).length
    }));

    const pullRequests: Node[] = config.mutedPullRequests.map((prNumber) => ({
      kind: 'mutedPullRequest',
      session,
      prNumber,
      pr: session.store.mutedPullRequest(prNumber)
    }));

    return [...authors, ...pullRequests];
  }

  private roots(): Node[] {
    const sessions = this.workspace.all();
    if (sessions.length === 1) return this.sections(sessions[0]);

    // Quiet repositories keep their row, so the list does not reshuffle as work comes and
    // goes and you can always see what GitRay is actually watching. When none of them has
    // anything to say the view empties out completely and the welcome content takes over,
    // exactly as it does for a single repository — a column of "nothing to report" rows is
    // not worth the space.
    const anything = sessions.some((session) => this.sections(session).length > 0);
    if (!anything) return [];

    return sessions.map((session) => ({ kind: 'repository', session }));
  }

  /** One repository's sections, in the order they deserve attention. */
  private sections(session: RepositorySession): Node[] {
    const nodes: Node[] = [];
    const status = session.store.currentStatus();

    if (status.state === 'degraded' || status.state === 'error') {
      nodes.push({ kind: 'status', session });
    }
    // Above the collisions on purpose. What has already landed is the more urgent of the
    // two, and it is also the row that keeps this view from emptying out on a quiet day.
    if (session.store.hasMainlineDrift()) {
      nodes.push({ kind: 'mainline', session });
    }
    if (session.scanner.hotFiles().length > 0) {
      nodes.push({ kind: 'collisionsHeader', session });
    }
    if (session.store.allPullRequests().length > 0) {
      nodes.push({ kind: 'pullRequestsHeader', session });
    }
    if (this.mutedNodes(session).length > 0) {
      nodes.push({ kind: 'mutedHeader', session });
    }

    return nodes;
  }

  // --- Item construction ---------------------------------------------------------------

  /**
   * One repository's row, shown only when there is more than one.
   *
   * The description is the same three counts the status bar totals up — open, behind,
   * colliding — so the row that contributed a number can be found by reading down the
   * list rather than by expanding each one in turn.
   */
  private repositoryItem(session: RepositorySession): vscode.TreeItem {
    const open = session.store.allPullRequests().length;
    const collisions = session.scanner.collisionCount();
    const behind = behindMainline(session.store.mainline());
    const status = session.store.currentStatus();
    const degraded = status.state === 'degraded' || status.state === 'error';

    const item = new vscode.TreeItem(session.label, vscode.TreeItemCollapsibleState.Expanded);

    const parts: string[] = [];
    if (open > 0) parts.push(`${open} open`);
    if (behind.count > 0) parts.push(`${behind.display} behind`);
    if (collisions > 0) parts.push(`⟂ ${collisions}`);
    item.description = parts.join(' · ') || (degraded ? 'unavailable' : 'nothing to report');

    item.iconPath =
      collisions > 0
        ? new vscode.ThemeIcon('repo', new vscode.ThemeColor('gitray.collisionForeground'))
        : new vscode.ThemeIcon('repo');

    const tooltip = new vscode.MarkdownString(
      `**${escapeMarkdown(session.label)}**\n\n${escapeMarkdown(session.repository.root)}`
    );
    tooltip.isTrusted = false;
    item.tooltip = tooltip;
    item.contextValue = 'gitray.repository';
    return item;
  }

  /**
   * The degraded-state row.
   *
   * Deliberately a tree row rather than a notification: the reasons here (signed out, no
   * GitHub remote, shallow clone) are persistent conditions, and a modal that reappears
   * every poll would be worse than the missing feature. Being signed out is the one that
   * has a fix worth a click, so that row — and only that row — is a button.
   */
  private statusItem(session: RepositorySession): vscode.TreeItem {
    const status = session.store.currentStatus();
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

    if (status.reason === 'signed-out') {
      item.iconPath = new vscode.ThemeIcon('sign-in');
      item.command = {
        command: 'gitray.signIn',
        title: 'Sign in to GitHub'
      };
    } else if (status.reason === 'gh-required') {
      item.command = {
        command: 'gitray.showOutput',
        title: 'Show log'
      };
    }
    return item;
  }

  /**
   * The "main has moved under you" row.
   *
   * One row, always, whenever the mainline is ahead — even when none of it touches your
   * work. That is the ambient half of drift tracking: knowing your branch is twelve commits
   * behind is worth a line of screen space, and it is also the only thing GitRay has to say
   * on a day with nothing open, which is exactly when it used to say nothing at all.
   */
  private mainlineItem(session: RepositorySession): vscode.TreeItem {
    const mainline = session.store.mainline();
    const commits = mainline?.commits ?? [];
    const branch = mainline?.branch ?? 'main';
    const behind = behindMainline(mainline);
    const affected = session.scanner
      .hotFiles()
      .filter((analysis) => analysis.regions.some((r) => r.origin.kind === 'mainline')).length;

    const item = new vscode.TreeItem(
      `${branch} has moved under you`,
      vscode.TreeItemCollapsibleState.None
    );
    const noun = behind.count === 1 && !behind.capped ? 'commit' : 'commits';
    item.description = affected > 0
      ? `${behind.display} ${noun} · ${affected} of your ${affected === 1 ? 'file' : 'files'}`
      : `${behind.display} ${noun} ahead`;
    item.iconPath = new vscode.ThemeIcon(
      affected > 0 ? 'warning' : 'git-merge',
      new vscode.ThemeColor(
        affected > 0 ? 'gitray.collisionForeground' : 'gitray.mainlineForeground'
      )
    );

    const lines = [
      `**Your branch left \`${codeSpan(branch)}\` ${behind.capped ? 'more than ' : ''}${behind.count} ${noun} ago.**`,
      '',
      affected > 0
        ? `${affected} of the files you have changed ${affected === 1 ? 'is' : 'are'} touched by what landed. Your next rebase will stop there.`
        : 'None of it touches what you have changed.',
      ''
    ];
    // Commit subjects and author names are free text from the repository, so they get the
    // same escaping the hover card gives them rather than being trusted to be plain.
    for (const commit of commits.slice(0, 8)) {
      lines.push(
        `- \`${commit.sha}\` ${escapeMarkdown(commit.subject)} — ${escapeMarkdown(commit.author)}`
      );
    }
    if (commits.length > 8) lines.push(`- … ${commits.length - 8} more`);

    const tooltip = new vscode.MarkdownString(lines.join('\n'));
    tooltip.isTrusted = false;
    item.tooltip = tooltip;
    item.contextValue = 'gitray.mainline';
    return item;
  }

  private collisionsHeaderItem(session: RepositorySession): vscode.TreeItem {
    const files = session.scanner.hotFiles();
    const collisions = session.scanner.collisionCount();

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
      'Files where your work overlaps someone else\'s — an open pull request, or something that already merged.\n\nComputed against the shared ancestor, the same way git decides whether a merge conflicts.'
    );
    item.contextValue = 'gitray.collisions';
    return item;
  }

  private collisionFileItem(
    session: RepositorySession,
    analysis: FileAnalysis
  ): vscode.TreeItem {
    const uri = session.repository.uriFor(analysis.path);
    const collisions = analysis.regions.filter((r) => r.severity === 'collision').length;
    const nearMisses = analysis.regions.filter((r) => r.severity === 'nearMiss').length;

    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.Expanded);
    item.description = collisions > 0 ? `⟂ ${collisions}` : `${nearMisses} nearby`;
    item.resourceUri = uri;
    item.contextValue = 'gitray.file';
    item.tooltip = analysis.path;
    return item;
  }

  private collisionRegionItem(
    session: RepositorySession,
    analysis: FileAnalysis,
    region: ResolvedRegion
  ): vscode.TreeItem {
    const prNumber = prNumberOf(region.origin);
    const pr = prNumber === undefined ? undefined : session.store.pullRequest(prNumber);
    const line = region.range.start + 1;

    const item = new vscode.TreeItem(
      region.origin.kind === 'mainline'
        ? `${region.author} · merged`
        : `${region.author} · #${prNumber}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.description =
      region.severity === 'collision'
        ? `line ${line} · overlaps yours`
        : `line ${line} · ${region.distance} away`;
    item.iconPath = new vscode.ThemeIcon(
      region.severity === 'collision' ? 'circle-filled' : 'circle-outline',
      new vscode.ThemeColor(hueColorId(session.store.hueForRegion(region)))
    );
    item.tooltip = new vscode.MarkdownString(
      `**${regionHeadline(region, pr)}**\n\n${analysis.path}:${line}`
    );
    item.command = {
      command: 'gitray.revealRegion',
      title: 'Reveal',
      // The root travels with the path: a repo-relative path names a different file in
      // every folder of a multi-root workspace, and this row knows which one it meant.
      arguments: [{ root: session.id, path: analysis.path, line: region.range.start }]
    };
    item.contextValue = 'gitray.region';
    return item;
  }

  private pullRequestsHeaderItem(session: RepositorySession): vscode.TreeItem {
    const pullRequests = session.store.allPullRequests();
    const authors = new Set(pullRequests.map((pr) => pr.author));

    const item = new vscode.TreeItem('Active pull requests', vscode.TreeItemCollapsibleState.Expanded);
    item.description = `${pullRequests.length} · ${authors.size} ${authors.size === 1 ? 'author' : 'authors'}`;
    item.iconPath = new vscode.ThemeIcon('git-pull-request');
    item.contextValue = 'gitray.pullRequests';
    return item;
  }

  private pullRequestItem(session: RepositorySession, pr: PullRequest): vscode.TreeItem {
    const item = new vscode.TreeItem(pr.title, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = `#${pr.number} · ${pr.author} · ${relativeTime(pr.updatedAt)}`;
    item.iconPath = new vscode.ThemeIcon(
      pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request',
      // Hues are assigned per repository, so the same person can read as a different colour
      // in two folders. That is the right trade: a hue's job is to tell collaborators apart
      // within one repository, and a window-wide palette would run out far sooner.
      new vscode.ThemeColor(hueColorId(session.store.hueFor(pr.author)))
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

  private pullRequestFileItem(
    session: RepositorySession,
    node: {
      pr: PullRequest;
      path: string;
      additions: number;
      deletions: number;
    }
  ): vscode.TreeItem {
    const uri = session.repository.uriFor(node.path);
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    item.description = `+${node.additions} −${node.deletions}`;
    item.resourceUri = uri;
    item.tooltip = node.path;
    item.contextValue = 'gitray.file';
    item.command = {
      command: 'gitray.diffWithPullRequest',
      title: 'Compare',
      arguments: [{ root: session.id, prNumber: node.pr.number, path: node.path }]
    };
    return item;
  }

  // --- Muted -----------------------------------------------------------------------------

  private mutedHeaderItem(session: RepositorySession): vscode.TreeItem {
    const rows = this.mutedNodes(session);
    const authors = rows.filter((node) => node.kind === 'mutedAuthor').length;
    const pullRequests = rows.length - authors;

    const item = new vscode.TreeItem('Muted', vscode.TreeItemCollapsibleState.Collapsed);
    const parts: string[] = [];
    if (authors > 0) parts.push(`${authors} ${authors === 1 ? 'author' : 'authors'}`);
    if (pullRequests > 0) {
      parts.push(`${pullRequests} pull ${pullRequests === 1 ? 'request' : 'requests'}`);
    }
    item.description = parts.join(' · ');
    item.iconPath = new vscode.ThemeIcon('bell-slash', new vscode.ThemeColor('disabledForeground'));
    item.tooltip = new vscode.MarkdownString(
      'Work GitRay has been told to leave out.\n\nMuting applies to open pull requests only — anything that has already merged still shows as mainline drift, because your next rebase does not care who you muted.'
    );
    item.contextValue = 'gitray.muted';
    return item;
  }

  /**
   * One muted pull request.
   *
   * The number is always known; the pull request behind it often is not. It may have
   * merged, or fallen past `maxPullRequests`, or `gh` may simply be unreachable this
   * session — so the row states what it knows rather than guessing which of those happened.
   * Unmuting works either way, which is the point of showing the row at all.
   */
  private mutedPullRequestItem(prNumber: number, pr: PullRequest | undefined): vscode.TreeItem {
    const item = new vscode.TreeItem(
      pr ? pr.title : `#${prNumber}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = pr ? `#${prNumber} · ${pr.author}` : 'not in the open list';
    item.iconPath = new vscode.ThemeIcon(
      'git-pull-request',
      new vscode.ThemeColor('disabledForeground')
    );
    item.tooltip = new vscode.MarkdownString(
      pr
        ? `**#${prNumber} · ${escapeMarkdown(pr.title)}**\n\n${escapeMarkdown(pr.author)} · \`${codeSpan(pr.headRefName)}\`\n\nMuted, so it is left out of every other surface.`
        : `**#${prNumber} is muted.**\n\nGitRay is not tracking it right now — it may have closed, it may be past \`gitray.maxPullRequests\`, or GitHub may be unreachable. Unmuting it is safe either way.`
    );
    item.contextValue = 'gitray.mutedPr';
    return item;
  }

  private mutedAuthorItem(author: string, hiding: number): vscode.TreeItem {
    const item = new vscode.TreeItem(author, vscode.TreeItemCollapsibleState.None);
    item.description =
      hiding > 0
        ? `${hiding} open pull ${hiding === 1 ? 'request' : 'requests'}`
        : 'nothing open right now';
    item.iconPath = new vscode.ThemeIcon('account', new vscode.ThemeColor('disabledForeground'));
    item.tooltip = new vscode.MarkdownString(
      `**${escapeMarkdown(author)} is muted.**\n\nTheir open pull requests are left out of every surface. Anything of theirs that has already merged still shows as mainline drift.`
    );
    item.contextValue = 'gitray.mutedAuthor';
    return item;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
  }
}

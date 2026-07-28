/**
 * The Radar panel: the whole repository's in-flight work on one screen.
 *
 * Two readings of the same data, because they answer different questions:
 *
 *  - **Hot spots** answers "where will this hurt?" — files more than one person is
 *    editing, ranked by how much they overlap your work. This is the actionable half.
 *  - **Lanes** answers "what is everyone doing?" — one lane per pull request, each file
 *    a block sized by how much of it changed. This is the ambient half.
 *
 * Data arrives by postMessage rather than being baked into the HTML, so the panel can
 * update in place on every sync and no repository content is ever interpolated into
 * markup.
 */

import * as vscode from 'vscode';
import { behindMainline, prNumberOf } from '../core/types.js';
import type { RepositorySession } from '../session.js';
import { hueColorId } from '../model/palette.js';
import { relativeTime } from '../ui/hover.js';

interface RadarFile {
  path: string;
  additions: number;
  deletions: number;
  collisions: number;
  nearMisses: number;
}

interface RadarPullRequest {
  number: number;
  title: string;
  author: string;
  hue: number;
  branch: string;
  updated: string;
  isDraft: boolean;
  files: RadarFile[];
}

interface RadarHotspot {
  path: string;
  collisions: number;
  nearMisses: number;
  contributors: { number: number; author: string; hue: number }[];
  /** True when something already merged touches this file. */
  merged: boolean;
}

interface RadarPayload {
  summary: {
    pullRequests: number;
    collaborators: number;
    collisions: number;
    lastSync: string | undefined;
    message: string | undefined;
    /** How far the mainline has moved since your branch left it; 0 when it has not. */
    behind: number;
    /** The same count as it should be shown — `20+` when the log hit its cap. */
    behindDisplay: string;
    mainlineBranch: string | undefined;
  };
  hotspots: RadarHotspot[];
  pullRequests: RadarPullRequest[];
  hueColorIds: string[];
}

export class RadarPanel implements vscode.Disposable {
  static readonly viewType = 'gitray.radar';
  private static instance: RadarPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  /**
   * The radar is about one repository at a time.
   *
   * Hot spots and lanes are both built from files that several people are editing, and
   * files from different repositories can never be the same file — merging them into one
   * view would produce a ranking where the top entry means nothing. So the panel belongs
   * to a session, and asking for a different one retargets it rather than opening a second.
   */
  static show(
    extensionUri: vscode.Uri,
    session: RepositorySession,
    qualified: boolean,
    onOpenFile: (path: string, line?: number) => void
  ): void {
    if (RadarPanel.instance) {
      if (RadarPanel.instance.session === session) {
        RadarPanel.instance.panel.reveal(vscode.ViewColumn.Active);
        return;
      }
      RadarPanel.instance.dispose();
    }

    const panel = vscode.window.createWebviewPanel(
      RadarPanel.viewType,
      title(session, qualified),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        // The panel rebuilds from the store in a few milliseconds, so keeping a hidden
        // webview alive would cost memory for no benefit.
        retainContextWhenHidden: false
      }
    );

    RadarPanel.instance = new RadarPanel(panel, extensionUri, session, qualified, onOpenFile);
  }

  static restore(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    session: RepositorySession,
    qualified: boolean,
    onOpenFile: (path: string, line?: number) => void
  ): void {
    RadarPanel.instance?.dispose();
    RadarPanel.instance = new RadarPanel(panel, extensionUri, session, qualified, onOpenFile);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly session: RepositorySession,
    qualified: boolean,
    private readonly onOpenFile: (path: string, line?: number) => void
  ) {
    this.panel = panel;
    this.panel.title = title(session, qualified);
    this.panel.webview.html = render(this.panel.webview, extensionUri);
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'gitray.svg');

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.session.onDidChange(() => this.post()),
      this.panel.webview.onDidReceiveMessage((message) => this.handle(message))
    );

    this.post();
  }

  private get store() {
    return this.session.store;
  }

  private get scanner() {
    return this.session.scanner;
  }

  private handle(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const { type, path, line } = message as { type?: string; path?: string; line?: number };

    switch (type) {
      case 'ready':
        this.post();
        break;
      case 'openFile':
        if (typeof path === 'string') this.onOpenFile(path, line);
        break;
      case 'refresh':
        // Named, so the button refreshes the repository the panel is showing rather than
        // every repository in the window.
        void vscode.commands.executeCommand('gitray.refresh', { root: this.session.id });
        break;
    }
  }

  private post(): void {
    if (!this.panel.visible && !this.panel.active) return;
    void this.panel.webview.postMessage(this.buildPayload());
  }

  private buildPayload(): RadarPayload {
    const pullRequests = this.store.allPullRequests();
    const status = this.store.currentStatus();

    const analysisFor = (path: string) => this.scanner.analysisFor(path);

    const radarPullRequests: RadarPullRequest[] = pullRequests.map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author,
      hue: this.store.hueFor(pr.author),
      branch: pr.headRefName,
      updated: relativeTime(pr.updatedAt),
      isDraft: pr.isDraft,
      files: pr.files.map((file) => {
        const regions =
          analysisFor(file.path)?.regions.filter(
            (r) => prNumberOf(r.origin) === pr.number
          ) ?? [];
        return {
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          collisions: regions.filter((r) => r.severity === 'collision').length,
          nearMisses: regions.filter((r) => r.severity === 'nearMiss').length
        };
      })
    }));

    const mainline = this.store.mainline();
    const behind = behindMainline(mainline);
    const hotspots = this.buildHotspots(radarPullRequests);

    return {
      summary: {
        pullRequests: pullRequests.length,
        collaborators: new Set(pullRequests.map((pr) => pr.author)).size,
        collisions: this.scanner.collisionCount(),
        lastSync: status.lastSync
          ? relativeTime(new Date(status.lastSync).toISOString())
          : undefined,
        message:
          status.state === 'degraded' || status.state === 'error' ? status.message : undefined,
        behind: behind.count,
        behindDisplay: behind.display,
        mainlineBranch: mainline?.branch
      },
      hotspots,
      pullRequests: radarPullRequests,
      hueColorIds: Array.from({ length: 8 }, (_, index) => hueColorId(index))
    };
  }

  /**
   * Files worth looking at: anything colliding with your work, or touched by more than
   * one pull request. A file only one person is changing is not a hot spot, however
   * large the change — nobody is going to fight over it.
   */
  private buildHotspots(pullRequests: readonly RadarPullRequest[]): RadarHotspot[] {
    const byPath = new Map<string, RadarHotspot>();
    const entryFor = (path: string): RadarHotspot => {
      let entry = byPath.get(path);
      if (!entry) {
        entry = { path, collisions: 0, nearMisses: 0, contributors: [], merged: false };
        byPath.set(path, entry);
      }
      return entry;
    };

    for (const pr of pullRequests) {
      for (const file of pr.files) {
        const entry = entryFor(file.path);
        entry.contributors.push({ number: pr.number, author: pr.author, hue: pr.hue });
        entry.collisions += file.collisions;
        entry.nearMisses += file.nearMisses;
      }
    }

    // Files where something that already merged meets your work. Most of these have no
    // open pull request behind them at all, so the loop above cannot have found them —
    // which was the old blind spot: the radar went dark on exactly the conflicts that
    // had stopped being hypothetical.
    for (const analysis of this.scanner.hotFiles()) {
      const drift = analysis.regions.filter((region) => region.origin.kind === 'mainline');
      if (drift.length === 0) continue;

      const entry = entryFor(analysis.path);
      entry.merged = true;
      entry.collisions += drift.filter((region) => region.severity === 'collision').length;
      entry.nearMisses += drift.filter((region) => region.severity === 'nearMiss').length;
    }

    return [...byPath.values()]
      .filter(
        (entry) =>
          entry.collisions > 0 ||
          entry.nearMisses > 0 ||
          entry.merged ||
          entry.contributors.length > 1
      )
      .sort(
        (a, b) =>
          b.collisions - a.collisions ||
          b.nearMisses - a.nearMisses ||
          b.contributors.length - a.contributors.length ||
          a.path.localeCompare(b.path)
      )
      .slice(0, 40);
  }

  dispose(): void {
    if (RadarPanel.instance === this) RadarPanel.instance = undefined;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
    this.panel.dispose();
  }
}

/** Name the repository in the tab only when there is more than one it could be. */
function title(session: RepositorySession, qualified: boolean): string {
  return qualified ? `GitRay Radar — ${session.label}` : 'GitRay Radar';
}

function render(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = makeNonce();
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'radar.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'radar.js'));

  // No remote origins are permitted at all: styles and the single script must come from
  // the extension itself, and nothing may be fetched, framed, or connected to.
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    "font-src 'none'",
    "connect-src 'none'"
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>GitRay Radar</title>
</head>
<body>
  <header class="masthead">
    <div class="title-row">
      <h1>Radar</h1>
      <button id="refresh" class="ghost" type="button">Refresh</button>
    </div>
    <div id="summary" class="summary"></div>
    <div id="notice" class="notice" hidden></div>
  </header>

  <main>
    <section id="hotspots-section" hidden>
      <h2>Hot spots</h2>
      <p class="section-note">Files more than one person is changing, most contested first.</p>
      <div id="hotspots" class="hotspots"></div>
    </section>

    <section id="lanes-section" hidden>
      <h2>Lanes</h2>
      <p class="section-note">One lane per pull request. Block width tracks how much of the file changed.</p>
      <div id="lanes" class="lanes"></div>
    </section>

    <div id="empty" class="empty" hidden></div>
  </main>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function makeNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return nonce;
}

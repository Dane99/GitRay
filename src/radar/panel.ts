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
import type { Store } from '../model/store.js';
import type { CollisionScanner } from '../sync/scanner.js';
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
}

interface RadarPayload {
  summary: {
    pullRequests: number;
    collaborators: number;
    collisions: number;
    lastSync: string | undefined;
    message: string | undefined;
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

  static show(
    extensionUri: vscode.Uri,
    store: Store,
    scanner: CollisionScanner,
    onOpenFile: (path: string, line?: number) => void
  ): void {
    if (RadarPanel.instance) {
      RadarPanel.instance.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      RadarPanel.viewType,
      'GitRay Radar',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        // The panel rebuilds from the store in a few milliseconds, so keeping a hidden
        // webview alive would cost memory for no benefit.
        retainContextWhenHidden: false
      }
    );

    RadarPanel.instance = new RadarPanel(panel, extensionUri, store, scanner, onOpenFile);
  }

  static restore(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    store: Store,
    scanner: CollisionScanner,
    onOpenFile: (path: string, line?: number) => void
  ): void {
    RadarPanel.instance?.dispose();
    RadarPanel.instance = new RadarPanel(panel, extensionUri, store, scanner, onOpenFile);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly store: Store,
    private readonly scanner: CollisionScanner,
    private readonly onOpenFile: (path: string, line?: number) => void
  ) {
    this.panel = panel;
    this.panel.webview.html = render(this.panel.webview, extensionUri);
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'gitray.svg');

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.store.onDidChange(() => this.post()),
      this.scanner.onDidChange(() => this.post()),
      this.panel.webview.onDidReceiveMessage((message) => this.handle(message))
    );

    this.post();
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
        void vscode.commands.executeCommand('gitray.refresh');
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
        const regions = analysisFor(file.path)?.regions.filter((r) => r.prNumber === pr.number) ?? [];
        return {
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          collisions: regions.filter((r) => r.severity === 'collision').length,
          nearMisses: regions.filter((r) => r.severity === 'nearMiss').length
        };
      })
    }));

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
          status.state === 'degraded' || status.state === 'error' ? status.message : undefined
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

    for (const pr of pullRequests) {
      for (const file of pr.files) {
        let entry = byPath.get(file.path);
        if (!entry) {
          entry = { path: file.path, collisions: 0, nearMisses: 0, contributors: [] };
          byPath.set(file.path, entry);
        }
        entry.contributors.push({ number: pr.number, author: pr.author, hue: pr.hue });
        entry.collisions += file.collisions;
        entry.nearMisses += file.nearMisses;
      }
    }

    return [...byPath.values()]
      .filter((entry) => entry.collisions > 0 || entry.nearMisses > 0 || entry.contributors.length > 1)
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

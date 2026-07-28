/**
 * Explorer badges.
 *
 * A two-character badge and a color on files an open pull request touches, which VS Code
 * propagates up to folders automatically — so a collapsed tree still shows you which
 * areas of the repository are busy.
 *
 * Badges use the file-level index, so they appear immediately after a sync without any
 * diffing, and escalate to the collision mark once the scanner has looked at the file.
 */

import * as vscode from 'vscode';
import { hueColorId } from '../model/palette.js';
import type { Workspace } from '../workspace.js';
import { relativeTime } from './hover.js';

export class GitRayFileDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.onDidChangeEmitter.event;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly workspace: Workspace) {
    this.disposables.push(
      this.onDidChangeEmitter,
      vscode.window.registerFileDecorationProvider(this),
      // Refreshing everything is the honest signal: a sync can add or remove badges
      // anywhere, and VS Code only re-queries the rows it is actually showing.
      this.workspace.onDidChange(() => this.onDidChangeEmitter.fire(undefined))
    );
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    // The explorer asks about every folder in the window, so the first question is which
    // repository — if any — this file belongs to. Everything below reads from that one.
    const session = this.workspace.sessionFor(uri);
    if (!session) return undefined;

    const { store, scanner } = session;
    const path = session.repository.relativePath(uri);
    if (!path) return undefined;

    const summary = store.fileSummary(path);
    const analysis = scanner.analysisFor(path);
    const regions = analysis?.regions ?? [];
    const collisions = regions.filter((region) => region.severity === 'collision').length;
    const drifted = regions.some((region) => region.origin.kind === 'mainline');

    // A merged change leaves no open pull request behind, so there is no file-level index
    // entry to hang a badge on. The scan result is the only evidence such a file exists,
    // and it is the one file most in need of a badge.
    if (!summary && !drifted) return undefined;

    const authors = summary?.authors ?? [];
    const tooltip = [
      collisions > 0
        ? `GitRay: ${collisions} ${collisions === 1 ? 'collision' : 'collisions'} with your work`
        : authors.length > 0
          ? `GitRay: ${authors.length} ${authors.length === 1 ? 'collaborator' : 'collaborators'} editing this file`
          : 'GitRay: work that already merged touches this file',
      '',
      ...(drifted ? [`${store.mainline()?.branch ?? 'main'} — already merged`] : []),
      ...store.pullRequestsForPath(path).map(
        (pr) => `#${pr.number} ${pr.title} — ${pr.author}, ${relativeTime(pr.updatedAt)}`
      )
    ].join('\n');

    if (collisions > 0) {
      return {
        badge: '⟂',
        color: new vscode.ThemeColor('gitray.collisionForeground'),
        tooltip,
        propagate: true
      };
    }

    if (authors.length === 0) {
      return {
        badge: '↧',
        color: new vscode.ThemeColor('gitray.mainlineForeground'),
        tooltip,
        propagate: true
      };
    }

    return {
      // Two characters is the hard limit, so a busy file reads as "9+" rather than
      // silently truncating to something misleading.
      badge: authors.length > 9 ? '9+' : String(authors.length),
      color: new vscode.ThemeColor(hueColorId(store.hueFor(authors[0] ?? ''))),
      tooltip,
      propagate: true
    };
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
  }
}

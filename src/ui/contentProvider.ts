/**
 * Serves collaborators' file versions as read-only virtual documents.
 *
 * This is what lets "compare with their version" open a real VS Code diff — with syntax
 * highlighting, inline navigation, and the usual editor affordances — instead of dumping
 * a patch into a panel. Content comes straight out of the fetched ref, so it costs one
 * `git show` and no network.
 *
 * URI shape: gitray://pr/<number>/<path>?ref=<ref>
 */

import * as vscode from 'vscode';
import type { Repository } from '../providers/repository.js';
import { prRef } from '../providers/git.js';

export const GITRAY_SCHEME = 'gitray';

export function pullRequestFileUri(prNumber: number, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GITRAY_SCHEME,
    authority: 'pr',
    path: `/${prNumber}/${path}`,
    query: `ref=${encodeURIComponent(prRef(prNumber))}`
  });
}

export class PullRequestContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly repository: Repository) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(GITRAY_SCHEME, this)
    );
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const match = /^\/(\d+)\/(.+)$/.exec(uri.path);
    if (!match) return '';

    const path = match[2];
    const ref = new URLSearchParams(uri.query).get('ref') ?? prRef(Number(match[1]));

    const content = await this.repository.git.showFile(ref, path);
    if (content !== undefined) return content;

    // The file not existing on their branch is a real answer — they added it, or the ref
    // has not been fetched yet — so say so in the diff rather than failing to open.
    return `// GitRay: ${path} does not exist in ${ref}.\n`;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
  }
}

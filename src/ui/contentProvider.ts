/**
 * Serves other people's file versions as read-only virtual documents.
 *
 * This is what lets "compare with their version" open a real VS Code diff — with syntax
 * highlighting, inline navigation, and the usual editor affordances — instead of dumping
 * a patch into a panel. Content comes straight out of a local ref, so it costs one
 * `git show` and no network.
 *
 * URI shapes:
 *   gitray://pr/<number>/<path>?ref=<ref>
 *   gitray://mainline/<path>?ref=<sha>
 *   gitray://base/<path>?ref=<sha>
 *
 * The pull request form carries its number in the path because that is what names the tab.
 * The other two cannot: a branch may contain slashes, which would make the boundary between
 * branch and file path ambiguous, so the commit travels in the query instead and the path
 * is nothing but the file.
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

/** The mainline's copy of a file, pinned to the commit it was analyzed against. */
export function mainlineFileUri(tip: string, path: string): vscode.Uri {
  return commitFileUri('mainline', tip, path);
}

/**
 * The file as it stood at the commit both sides edited away from.
 *
 * This is the left-hand side of a "just their change" diff: putting the base here instead
 * of your working copy is what keeps your own edits out of the result, so what remains is
 * theirs alone. The cost is that the line numbers are the base's, not your buffer's — which
 * is why this view accompanies the working-copy diff rather than replacing it.
 */
export function baseFileUri(baseSha: string, path: string): vscode.Uri {
  return commitFileUri('base', baseSha, path);
}

function commitFileUri(authority: string, ref: string, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GITRAY_SCHEME,
    authority,
    path: `/${path}`,
    query: `ref=${encodeURIComponent(ref)}`
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
    const resolved = resolve(uri);
    if (!resolved) return '';

    const { path, ref } = resolved;
    const content = await this.repository.git.showFile(ref, path);
    if (content !== undefined) return content;

    // The file not existing on the other side is a real answer — it was added there, or
    // the ref has not been fetched yet — so say so in the diff rather than failing to open.
    return `// GitRay: ${path} does not exist in ${ref}.\n`;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
  }
}

/** Pull the file path and the ref to read it from back out of a gitray: URI. */
function resolve(uri: vscode.Uri): { path: string; ref: string } | undefined {
  const ref = new URLSearchParams(uri.query).get('ref') ?? undefined;

  // Only the pull request form encodes anything but the file in its path; every other
  // authority is a bare commit, and they all read the same way.
  if (uri.authority !== 'pr') {
    const path = uri.path.replace(/^\//, '');
    return path && ref ? { path, ref } : undefined;
  }

  const match = /^\/(\d+)\/(.+)$/.exec(uri.path);
  if (!match) return undefined;
  return { path: match[2], ref: ref ?? prRef(Number(match[1])) };
}

/**
 * Open a repository file in the editor, optionally revealing a line.
 *
 * Shared by every surface that jumps to code — commands, the tree, and the radar — so
 * they all land the same way: a real (non-preview) editor, cursor on the target line,
 * scrolled into view without recentering when it is already visible.
 */

import * as vscode from 'vscode';
import type { Repository } from '../providers/repository.js';

export async function openWorkspaceFile(
  repository: Repository,
  path: string,
  line?: number
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(repository.uriFor(path));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  if (line !== undefined) {
    const target = new vscode.Range(line, 0, line, 0);
    editor.selection = new vscode.Selection(target.start, target.start);
    editor.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

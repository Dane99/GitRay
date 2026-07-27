/**
 * Binds a workspace folder to the git repository and GitHub repository behind it.
 *
 * GitRay speaks in repo-relative POSIX paths everywhere — that is what `gh` reports and
 * what git diffs contain — so path conversion lives here and nowhere else.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { Git } from './git.js';
import { Gh } from './gh.js';

export class Repository {
  readonly git: Git;
  readonly gh: Gh;

  private constructor(
    readonly root: string,
    /** The actual .git directory — not `<root>/.git` in a linked worktree. */
    private readonly gitDir: string,
    readonly folder: vscode.WorkspaceFolder
  ) {
    this.git = new Git(root);
    this.gh = new Gh(root);
  }

  /** Resolve the git repository containing a workspace folder, if there is one. */
  static async discover(folder: vscode.WorkspaceFolder): Promise<Repository | undefined> {
    const probe = new Git(folder.uri.fsPath);
    const root = await probe.repositoryRoot();
    if (!root) return undefined;
    const gitDir = (await probe.gitDir()) ?? path.join(root, '.git');
    return new Repository(path.normalize(root), path.normalize(gitDir), folder);
  }

  /**
   * Convert a file URI to a repo-relative POSIX path.
   *
   * Undefined when the file sits outside this repository, which happens constantly in
   * multi-root workspaces and for the editor's own virtual documents.
   */
  relativePath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') return undefined;

    const relative = path.relative(this.root, uri.fsPath);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return undefined;
    }
    return relative.split(path.sep).join('/');
  }

  /** Convert a repo-relative POSIX path back to a file URI. */
  uriFor(relativePath: string): vscode.Uri {
    return vscode.Uri.file(path.join(this.root, ...relativePath.split('/')));
  }

  /**
   * Watches the files that indicate HEAD moved under us — a checkout, merge, or rebase.
   *
   * A plain commit rewrites neither of these (it moves `refs/heads/<branch>`, which HEAD
   * points at symbolically), so commits are noticed by the sync engine's head check on
   * the next pass rather than here.
   */
  createHeadWatcher(): vscode.FileSystemWatcher {
    return vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.gitDir), '{HEAD,ORIG_HEAD}')
    );
  }
}

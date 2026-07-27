/**
 * Local git operations.
 *
 * Everything GitRay knows about file *content* comes from here. The remote is contacted
 * only to fetch pull request heads, and even then nothing is merged, rebased, or checked
 * out — objects land in an isolated ref namespace and are read from there.
 */

import { run, CommandError } from '../core/exec.js';
import { parseUnifiedDiff, type FileDiff } from '../model/diffParse.js';

/** Where GitRay parks fetched pull request heads. Deliberately outside refs/heads. */
export const REF_NAMESPACE = 'refs/gitray/pr';

export function prRef(prNumber: number): string {
  return `${REF_NAMESPACE}/${prNumber}`;
}

export class Git {
  constructor(private readonly cwd: string) {}

  private async git(args: string[], okExitCodes?: number[]): Promise<string> {
    const result = await run(
      'git',
      // core.quotePath=false keeps non-ASCII paths readable instead of C-quoted octal.
      ['-c', 'core.quotePath=false', ...args],
      { cwd: this.cwd, okExitCodes }
    );
    return result.stdout;
  }

  /** Absolute path of the repository root, or undefined when cwd is not a repo. */
  async repositoryRoot(): Promise<string | undefined> {
    try {
      const out = await this.git(['rev-parse', '--show-toplevel']);
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async currentBranch(): Promise<string | undefined> {
    try {
      const out = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = out.trim();
      return branch === 'HEAD' ? undefined : branch;
    } catch {
      return undefined;
    }
  }

  async headSha(): Promise<string | undefined> {
    try {
      return (await this.git(['rev-parse', 'HEAD'])).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async hasRemote(name = 'origin'): Promise<boolean> {
    try {
      const out = await this.git(['remote']);
      return out.split('\n').some((line) => line.trim() === name);
    } catch {
      return false;
    }
  }

  /**
   * The commit a ref currently points at, or undefined when the ref does not exist.
   *
   * Callers use this rather than an object-existence check to decide whether a fetch is
   * needed. The distinction matters: the objects for a pull request head can be present
   * while `refs/gitray/pr/<n>` is absent — after the refs are removed, or after a force
   * push left ours pointing at a commit that is no longer the head. In both cases the
   * object is there but every ref-based operation would fail, so "do we have the object"
   * is the wrong question.
   */
  async refOid(ref: string): Promise<string | undefined> {
    try {
      const out = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], [1]);
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Fetch the given pull request heads into refs/gitray/pr/*.
   *
   * One invocation for the whole batch, because each fetch pays a full connection
   * handshake. Callers should filter out pull requests whose head object is already
   * present so an idle poll transfers nothing at all.
   */
  async fetchPullRequests(prNumbers: readonly number[], remote = 'origin'): Promise<void> {
    if (prNumbers.length === 0) return;
    const refspecs = prNumbers.map((n) => `+refs/pull/${n}/head:${prRef(n)}`);
    await this.git(['fetch', '--no-tags', '--quiet', remote, ...refspecs]);
  }

  /** Ref names currently under the GitRay namespace, as pull request numbers. */
  async trackedPullRequests(): Promise<number[]> {
    try {
      const out = await this.git(['for-each-ref', '--format=%(refname)', REF_NAMESPACE]);
      return out
        .split('\n')
        .map((line) => Number(line.trim().slice(`${REF_NAMESPACE}/`.length)))
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      return [];
    }
  }

  /** Drop refs for pull requests that are no longer open. */
  async deleteRefs(prNumbers: readonly number[]): Promise<void> {
    for (const number of prNumbers) {
      try {
        await this.git(['update-ref', '-d', prRef(number)]);
      } catch {
        // A ref that is already gone is the desired state.
      }
    }
  }

  /** Remove every GitRay ref, returning the repository to its original state. */
  async deleteAllRefs(): Promise<number> {
    const tracked = await this.trackedPullRequests();
    await this.deleteRefs(tracked);
    return tracked.length;
  }

  /**
   * Common ancestor of HEAD and a pull request head.
   *
   * Undefined when the histories are unrelated, which happens with a rewritten branch or
   * a shallow clone. Callers fall back to file-level indicators in that case rather than
   * guessing at coordinates.
   */
  async mergeBase(ref: string, other = 'HEAD'): Promise<string | undefined> {
    try {
      const out = await this.git(['merge-base', other, ref], [1]);
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Where your branch left the mainline, for a pull request's base branch.
   *
   * This is the reference point for deciding what counts as *your* work. Measuring
   * against the pull request's own merge base instead would count every upstream commit
   * that landed since it branched — real conflicts for that pull request's author, but
   * not yours, and reporting them as yours would make every clean checkout look alarming.
   *
   * Undefined when the base branch has no remote-tracking ref, in which case callers fall
   * back to the merge base.
   */
  async mainlineBase(baseRefName: string, remote = 'origin'): Promise<string | undefined> {
    if (!baseRefName) return undefined;
    const remoteRef = `refs/remotes/${remote}/${baseRefName}`;
    if (!(await this.refOid(remoteRef))) return undefined;
    return this.mergeBase(remoteRef);
  }

  /** Is this a shallow clone? Merge bases with a PR head are unreliable if so. */
  async isShallow(): Promise<boolean> {
    try {
      const out = await this.git(['rev-parse', '--is-shallow-repository']);
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** File content at a commit. Undefined when the path does not exist there. */
  async showFile(sha: string, path: string): Promise<string | undefined> {
    try {
      return await this.git(['show', `${sha}:${path}`]);
    } catch (error) {
      if (error instanceof CommandError) return undefined;
      throw error;
    }
  }

  /**
   * Changes a pull request makes relative to its merge base with HEAD.
   *
   * Zero context lines, because conflict detection needs the minimal touched range —
   * context would inflate every hunk and make unrelated edits look adjacent.
   */
  async diffRange(
    fromSha: string,
    toRef: string,
    paths?: readonly string[]
  ): Promise<FileDiff[]> {
    const args = [
      'diff',
      '--unified=0',
      '--no-color',
      '--no-ext-diff',
      '--find-renames',
      '--diff-algorithm=histogram',
      fromSha,
      toRef
    ];
    if (paths && paths.length > 0) {
      args.push('--', ...paths);
    }
    try {
      return parseUnifiedDiff(await this.git(args));
    } catch (error) {
      if (error instanceof CommandError) return [];
      throw error;
    }
  }

  /**
   * Files you have changed relative to a commit, including uncommitted work.
   *
   * Comparing against the merge base rather than HEAD is what makes this the right set:
   * it catches everything you have diverged by, whether it is still in your working tree
   * or already committed on your branch. Both count for conflict purposes.
   */
  async changedSince(baseSha: string): Promise<string[]> {
    try {
      const out = await this.git(['diff', '--name-only', baseSha]);
      return out.split('\n').map((line) => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Names of files a pull request touches, without transferring any content. */
  async changedPaths(fromSha: string, toRef: string): Promise<string[]> {
    try {
      const out = await this.git(['diff', '--name-only', '--no-renames', fromSha, toRef]);
      return out.split('\n').map((line) => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Absolute path of the .git directory, or undefined outside a repository.
   *
   * Not always `<root>/.git`: in a linked worktree `.git` is a file pointing at the real
   * directory, and anything that wants to watch HEAD has to watch where HEAD actually is.
   */
  async gitDir(): Promise<string | undefined> {
    try {
      const out = await this.git(['rev-parse', '--absolute-git-dir']);
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** True when the working tree has no uncommitted changes. */
  async isClean(): Promise<boolean> {
    try {
      const out = await this.git(['status', '--porcelain']);
      return out.trim() === '';
    } catch {
      return false;
    }
  }
}

/**
 * Local git operations.
 *
 * Everything GitRay knows about file *content* comes from here. The remote is contacted
 * only to fetch pull request heads, and even then nothing is merged, rebased, or checked
 * out — objects land in an isolated ref namespace and are read from there.
 */

import { run, CommandError } from '../core/exec.js';
import { parseUnifiedDiff, type FileDiff } from '../model/diffParse.js';
import type { MainlineCommit } from '../core/types.js';
import { MAX_LOGGED_COMMITS } from '../core/types.js';

/** Where GitRay parks everything it fetches. Deliberately outside refs/heads. */
export const GITRAY_NAMESPACE = 'refs/gitray';
export const REF_NAMESPACE = `${GITRAY_NAMESPACE}/pr`;
export const MAINLINE_NAMESPACE = `${GITRAY_NAMESPACE}/mainline`;

export function prRef(prNumber: number): string {
  return `${REF_NAMESPACE}/${prNumber}`;
}

/**
 * Where GitRay parks its own copy of the mainline.
 *
 * Deliberately *not* `refs/remotes/origin/<branch>`. Advancing the real remote-tracking
 * ref would change what `git status` and every other tool reports — suddenly announcing
 * "your branch is behind by 12 commits" is the user's business, not an extension's side
 * effect. A private ref gives GitRay the fresh tip it needs and leaves their git alone.
 */
export function mainlineRef(branch: string): string {
  return `${MAINLINE_NAMESPACE}/${branch}`;
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
   * The configured URL for a remote, exactly as git has it.
   *
   * `get-url` rather than reading `remote.<name>.url` directly, so that `insteadOf`
   * rewrites are applied — a corporate config that maps every github.com URL onto an
   * internal mirror should be visible to whoever is deciding which host this is.
   */
  async remoteUrl(name = 'origin'): Promise<string | undefined> {
    try {
      return (await this.git(['remote', 'get-url', name])).trim() || undefined;
    } catch {
      return undefined;
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

  /** Every ref under the GitRay namespace, pull request heads and mainline copies alike. */
  private async allRefs(): Promise<string[]> {
    try {
      const out = await this.git(['for-each-ref', '--format=%(refname)', GITRAY_NAMESPACE]);
      return out.split('\n').map((line) => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Remove every GitRay ref, returning the repository to its original state. */
  async deleteAllRefs(): Promise<number> {
    const refs = await this.allRefs();
    for (const ref of refs) {
      try {
        await this.git(['update-ref', '-d', ref]);
      } catch {
        // A ref that is already gone is the desired state.
      }
    }
    return refs.length;
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
   * The freshest commit we have for a branch on the remote.
   *
   * GitRay's own copy wins when it exists, because it is the one this extension keeps
   * current; the user's remote-tracking ref is the fallback for everything that happens
   * before the first mainline fetch, or when fetching is turned off entirely.
   */
  async mainlineTip(branch: string, remote = 'origin'): Promise<string | undefined> {
    if (!branch) return undefined;
    return (
      (await this.refOid(mainlineRef(branch))) ??
      (await this.refOid(`refs/remotes/${remote}/${branch}`))
    );
  }

  /**
   * Where your branch left the mainline, for a pull request's base branch.
   *
   * This is the reference point for deciding what counts as *your* work. Measuring
   * against the pull request's own merge base instead would count every upstream commit
   * that landed since it branched — real conflicts for that pull request's author, but
   * not yours, and reporting them as yours would make every clean checkout look alarming.
   *
   * A fresher tip does not move this commit: the mainline only grows, and adding commits
   * on top of it cannot change where your branch diverged. So fetching the mainline buys
   * drift detection without disturbing what counts as your work.
   *
   * Undefined when the branch is unknown locally, in which case callers fall back to the
   * merge base.
   */
  async mainlineBase(baseRefName: string, remote = 'origin'): Promise<string | undefined> {
    const tip = await this.mainlineTip(baseRefName, remote);
    if (!tip) return undefined;
    return this.mergeBase(tip);
  }

  /**
   * Update GitRay's copy of a branch from the remote.
   *
   * One refspec, forced, into the private namespace — the same shape as a pull request
   * head fetch, and just as incapable of touching a local branch or the working tree.
   */
  async fetchMainline(branch: string, remote = 'origin'): Promise<void> {
    if (!branch) return;
    await this.git([
      'fetch',
      '--no-tags',
      '--quiet',
      remote,
      `+refs/heads/${branch}:${mainlineRef(branch)}`
    ]);
  }

  /**
   * The remote's default branch, as recorded by `git clone` or `git remote set-head`.
   *
   * Undefined in a repository where nobody ever set it, which is common enough that
   * callers need a fallback rather than treating it as an error.
   */
  async defaultBranch(remote = 'origin'): Promise<string | undefined> {
    try {
      const out = await this.git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], [1, 128]);
      const ref = out.trim();
      const prefix = `${remote}/`;
      return ref.startsWith(prefix) ? ref.slice(prefix.length) || undefined : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * What landed between two commits, newest first.
   *
   * `--first-parent` is what makes this readable: it walks the mainline's own history
   * rather than every commit that was ever merged into it, so a squash-merged repository
   * yields one entry per pull request and a merge-commit repository yields the merge
   * commits — in both cases, one line per thing that landed, which is how people think
   * about it. Without it a single merged branch would arrive as thirty commits.
   */
  async commitsIn(
    fromSha: string,
    toRef: string,
    path?: string,
    limit = MAX_LOGGED_COMMITS
  ): Promise<MainlineCommit[]> {
    const args = [
      'log',
      '--first-parent',
      `--max-count=${limit}`,
      `--format=%h${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s`,
      `${fromSha}..${toRef}`
    ];
    if (path) args.push('--', path);

    try {
      const out = await this.git(args);
      return out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseCommitLine)
        .filter((commit): commit is MainlineCommit => commit !== undefined);
    } catch {
      // The log is a nicety on top of the diff, so losing it must not lose the region.
      return [];
    }
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

/** ASCII unit separator: cannot occur in a sha, a name, or a commit subject. */
const FIELD_SEPARATOR = '\x1f';

/**
 * Recover the pull request number a merged commit came from.
 *
 * Both of GitHub's merge styles leave it in the subject — `Merge pull request #123 from …`
 * for a merge commit, a trailing `(#123)` for a squash — so the change that landed can
 * still be linked back to the discussion that produced it. A direct push has neither, and
 * inventing a number for one would be worse than showing none.
 */
function pullRequestNumberFromSubject(subject: string): number | undefined {
  const match = /^Merge pull request #(\d+)\b/.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
  if (!match) return undefined;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function parseCommitLine(line: string): MainlineCommit | undefined {
  const [sha, author, date, ...rest] = line.split(FIELD_SEPARATOR);
  // A subject is free text; anything after the fourth field belongs to it.
  const subject = rest.join(FIELD_SEPARATOR);
  if (!sha || !subject) return undefined;

  return {
    sha,
    author: author || 'unknown',
    date: date || '',
    subject,
    prNumber: pullRequestNumberFromSubject(subject)
  };
}

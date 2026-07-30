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
 * Deliberately *not* `refs/remotes/<remote>/<branch>`. Advancing the real remote-tracking
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

  /**
   * Every configured remote, in git's own order.
   *
   * Which of them GitRay should be talking to is not a question for this class — see
   * remoteSelection.ts. Nothing here defaults to `origin`, deliberately: a fork's `origin`
   * answers every one of these calls without error and with nothing in it.
   */
  async remotes(): Promise<string[]> {
    try {
      const out = await this.git(['remote']);
      return out.split('\n').map((line) => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * The configured URL for a remote, exactly as git has it.
   *
   * `get-url` rather than reading `remote.<name>.url` directly, so that `insteadOf`
   * rewrites are applied — a corporate config that maps every github.com URL onto an
   * internal mirror should be visible to whoever is deciding which host this is.
   */
  async remoteUrl(name: string): Promise<string | undefined> {
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
  async fetchPullRequests(prNumbers: readonly number[], remote: string): Promise<void> {
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
   * Is one commit reachable from another?
   *
   * Exit code 1 is the answer "no", not a failure, so it is allowed through; anything else
   * — an unknown rev, most likely — is a genuine error and is left to throw.
   */
  async isAncestor(maybeAncestor: string, descendant: string): Promise<boolean> {
    const result = await run(
      'git',
      ['merge-base', '--is-ancestor', maybeAncestor, descendant],
      { cwd: this.cwd, okExitCodes: [1] }
    );
    return result.code === 0;
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
   *
   * That fallback needs a remote to name, and a repository can have none — in which case
   * GitRay's own copy, if some earlier session left one, is the only answer available.
   */
  async mainlineTip(branch: string, remote: string | undefined): Promise<string | undefined> {
    if (!branch) return undefined;
    const own = await this.refOid(mainlineRef(branch));
    if (own || !remote) return own;
    return this.refOid(`refs/remotes/${remote}/${branch}`);
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
  async mainlineBase(
    baseRefName: string,
    remote: string | undefined
  ): Promise<string | undefined> {
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
  async fetchMainline(branch: string, remote: string): Promise<void> {
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
  async defaultBranch(remote: string): Promise<string | undefined> {
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

  /**
   * Check out a pull request's head as an ordinary local branch.
   *
   * The one operation in GitRay that touches the working tree, and the only one that writes
   * outside `refs/gitray/*` — so it is deliberately the shape a person would type by hand,
   * and it refuses rather than improvises when the branch it wants already exists.
   *
   * Where the head comes from depends on where it lives. A branch in the base repository
   * has a real ref to track; a fork's branch has none, and GitHub publishes it under the
   * base repository's `refs/pull/<n>/head` instead — which is also the only copy a
   * contributor without access to the fork can reach.
   *
   * The branch config is what stops the checkout being a dead end. Without it `git pull`
   * has nothing to pull from and `git push` guesses, which for a fork means pushing the
   * contributor's work into the base repository under their branch name. So the branch is
   * wired to whatever it can legitimately reach: the fork when the pull request allows
   * maintainer edits, the read-only pull ref when it does not, the real branch otherwise.
   */
  async checkoutPullRequest(pr: PullRequestCheckout): Promise<void> {
    const headRef = `refs/pull/${pr.prNumber}/head`;
    const local = `refs/heads/${pr.branch}`;

    if (await this.refOid(local)) {
      // Never rewrite a branch somebody already has. A fast-forward is the whole of what is
      // safe, and it is decided *before* switching: `merge --ff-only` would refuse just as
      // correctly, but only after the checkout had already moved the user off whatever they
      // were working on, leaving them on a stranger's branch to read the error from.
      await this.git(['fetch', '--no-tags', '--quiet', pr.remote, headRef]);
      const fetched = await this.refOid('FETCH_HEAD');
      if (!fetched) {
        throw new Error(`the head of pull request #${pr.prNumber} did not arrive.`);
      }

      // Either direction is fine. Behind is the fast-forward itself; ahead is a maintainer
      // who has already committed on top of the contributor's branch, and their commit has
      // to survive this.
      const behind = await this.isAncestor(local, fetched);
      const ahead = behind ? false : await this.isAncestor(fetched, local);
      if (!behind && !ahead) {
        throw new Error(
          `the local branch \`${pr.branch}\` has commits that pull request #${pr.prNumber} does not. ` +
            'Rename or delete it and try again — GitRay will not move a branch that would lose work.'
        );
      }

      await this.git(['checkout', pr.branch]);
      if (behind) await this.git(['merge', '--ff-only', 'FETCH_HEAD']);
    } else {
      await this.git(['fetch', '--no-tags', '--quiet', pr.remote, `${headRef}:${local}`]);
      await this.git(['checkout', pr.branch]);
    }

    const [trackedRemote, trackedRef] = pr.pushUrl
      ? [pr.pushUrl, `refs/heads/${pr.headRefName}`]
      : pr.isCrossRepository
        ? [pr.remote, headRef]
        : [pr.remote, `refs/heads/${pr.headRefName}`];

    await this.git(['config', `branch.${pr.branch}.remote`, trackedRemote]);
    await this.git(['config', `branch.${pr.branch}.merge`, trackedRef]);
    if (pr.pushUrl) {
      await this.git(['config', `branch.${pr.branch}.pushRemote`, pr.pushUrl]);
    }
  }
}

/** Everything `checkoutPullRequest` needs to know that git cannot work out for itself. */
export interface PullRequestCheckout {
  prNumber: number;
  /** The local branch to land on. */
  branch: string;
  /** The remote the pull request's *base* repository is configured as. */
  remote: string;
  /** What the branch is called on the repository the head lives in. */
  headRefName: string;
  /** Whether that repository is a fork rather than the base repository. */
  isCrossRepository: boolean;
  /** The fork's clone URL, when the pull request allows pushing back to it. */
  pushUrl?: string;
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

/**
 * Where things live on GitHub's web UI, derived rather than asked for.
 *
 * GitRay knows a pull request's URL and it knows which file you are looking at. GitHub's
 * Files tab names every file with an anchor, and the anchor is computable — so the link out
 * of a hover card can land on the change you were reading instead of on the top of a pull
 * request you then have to search. That is one round trip saved per click, which is the same
 * bargain the diff preview in the hover makes.
 *
 * Nothing here talks to GitHub; see github.ts for that. These are string facts about its
 * URL scheme, kept apart so they can be tested without an editor.
 */

import { createHash } from 'node:crypto';

/**
 * GitHub's per-file anchor on any diff page: `diff-` followed by the sha256 of the path.
 *
 * The path is hashed in the form its diffs carry — repo-relative, POSIX separators, no
 * leading slash — which is the form GitRay uses everywhere else, so nothing needs converting
 * on the way in. Which *spelling* of a renamed file to hand it is a separate question, and
 * one this cannot answer; see `pullRequestFileUrl`.
 */
export function fileDiffAnchor(path: string): string {
  return `diff-${createHash('sha256').update(path, 'utf8').digest('hex')}`;
}

/**
 * A pull request's Files tab, scrolled to one file.
 *
 * The anchor is a hash of a path, so the link lands only when both sides spell that path
 * the same way. Callers pass it as *your working tree* spells it; the page's anchors use it
 * as *that diff* spells it. A rename sitting between the two is what pulls them apart, and
 * it comes from either direction — the pull request renames the file itself, so its diff
 * carries a name your checkout has never had; or a rename landed after it merged, so your
 * checkout carries a name its diff never had. (The page's side is verified, not assumed:
 * GitHub anchors a renamed file by the *new* spelling of its path.)
 *
 * Both miss the same way. The fragment names nothing on the page, the browser stays at the
 * top of the Files tab, and that is where this link used to land anyway — the cost is a
 * scroll, never a wrong destination. Nothing here tries to detect the case: GitRay would
 * have to know the diff's own spelling to do better, and being wrong about which name to
 * hash would scroll to some other file rather than to none.
 *
 * Tolerant about what it is handed because two sources feed it: the url GitHub reported for
 * a pull request, and one derived from a remote. Both are clean today; a trailing slash or
 * an existing fragment from either must not produce a doubled path.
 */
export function pullRequestFileUrl(pullRequestUrl: string, path: string): string {
  const base = pullRequestUrl.replace(/#.*$/, '').replace(/\/+$/, '');
  const files = base.endsWith('/files') ? base : `${base}/files`;
  return `${files}#${fileDiffAnchor(path)}`;
}

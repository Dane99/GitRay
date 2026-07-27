/**
 * Development helper: manufacture a genuine collision in a target repository.
 *
 * Finds a line an open pull request actually changes, maps it from that pull request's
 * merge-base coordinates into your working tree's coordinates, and overwrites it. The
 * result is a real overlap GitRay should flag — handy for seeing the collision treatment
 * without waiting for a colleague to touch the same code as you.
 *
 *   npx tsx scripts/demo-collision.ts <path-to-repo>
 *   npx tsx scripts/demo-collision.ts <path-to-repo> --revert
 *
 * Two details here mirror what the extension has to get right, and both are easy to get
 * wrong: hunk line numbers are relative to the merge base rather than to your checkout,
 * and a Windows checkout is usually CRLF while the stored blob is LF.
 */

/* eslint-disable no-console */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Git, prRef } from '../src/providers/git.js';
import { Gh } from '../src/providers/gh.js';
import { RemoteSelector } from '../src/providers/remoteSelection.js';
import { alignLines, splitLines } from '../src/model/lineMap.js';

async function main(): Promise<number> {
  const repo = process.argv[2];
  const revert = process.argv.includes('--revert');

  if (!repo) {
    console.error('usage: npx tsx scripts/demo-collision.ts <path-to-repo> [--revert]');
    return 1;
  }

  if (revert) {
    execFileSync('git', ['checkout', '--', '.'], { cwd: repo, stdio: 'inherit' });
    console.log('working tree restored');
    return 0;
  }

  const git = new Git(repo);
  const gh = new Gh(repo);

  const state = await gh.probe();
  if (state.kind !== 'ok') {
    console.error(`cannot read this repository: ${state.kind}`);
    return 1;
  }
  console.log(`${state.nameWithOwner} as ${state.login}`);

  // The same resolution the extension does, for the same reason: in a fork the pull requests
  // are on `upstream` and fetching them from `origin` silently gets nothing.
  const remotes = new RemoteSelector(git, () => '');
  remotes.setBaseRepository({ nameWithOwner: state.nameWithOwner, host: state.host });
  const remote = await remotes.name();
  if (!remote) {
    console.error('this repository has no remote to fetch from');
    return 1;
  }
  console.log(`fetching from ${remote}`);

  const pullRequests = await gh.listPullRequests(30, false);
  console.log(`${pullRequests.length} open pull requests`);

  // Match the extension's own fetch decision: compare the ref, not merely whether the
  // object happens to be present.
  const missing: number[] = [];
  for (const pr of pullRequests) {
    if ((await git.refOid(prRef(pr.number))) !== pr.headRefOid) missing.push(pr.number);
  }
  if (missing.length > 0) {
    console.log(`fetching ${missing.length} pull request head(s)...`);
    await git.fetchPullRequests(missing, remote);
  }

  for (const pr of pullRequests) {
    const base = await git.mergeBase(prRef(pr.number));
    if (!base) continue;

    for (const file of pr.files) {
      if (!/\.(ts|js|mjs|md)$/.test(file.path)) continue;

      const diffs = await git.diffRange(base, prRef(pr.number), [file.path]);
      const hunk = diffs
        .flatMap((diff) => diff.hunks)
        .find((candidate) => candidate.baseRange.end > candidate.baseRange.start);
      if (!hunk) continue;

      const baseText = await git.showFile(base, file.path);
      if (baseText === undefined) continue;

      const full = join(repo, ...file.path.split('/'));
      let raw: string;
      try {
        raw = readFileSync(full, 'utf8');
      } catch {
        continue;
      }

      // Split both sides the same way the extension does. Using a bare '\n' here would
      // leave a carriage return on every line of a Windows checkout, making the file look
      // entirely rewritten and mapping the range to nowhere.
      const lines = splitLines(raw);
      const eol = raw.includes('\r\n') ? '\r\n' : '\n';

      const { start, end } = alignLines(splitLines(baseText), lines).toBufferRange(hunk.baseRange);
      if (end > lines.length || end === start) continue;

      for (let line = start; line < end; line++) {
        lines[line] = `// GITRAY DEMO EDIT - collides with #${pr.number}`;
      }
      writeFileSync(full, lines.join(eol), 'utf8');

      console.log('');
      console.log(`edited   ${file.path}`);
      console.log(`lines    ${start + 1}-${end}  (merge base ${hunk.baseRange.start + 1}-${hunk.baseRange.end})`);
      console.log(`collides #${pr.number} by ${pr.author} - ${pr.title}`);
      console.log('');
      console.log('Open that file in the Extension Development Host to see the collision.');
      console.log(`Undo with: npx tsx scripts/demo-collision.ts "${repo}" --revert`);
      return 0;
    }
  }

  console.error('no suitable hunk found - try a repository with more open pull requests');
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);

# Changelog

## 0.1.4

- The exponential backoff for unreachable remotes now actually engages. The sync engine
  swallowed its own failures, so the scheduler's failure counter never moved and a dead
  network was retried at full cadence forever, despite the README promising otherwise.
- The collision scanner no longer reuses stale line alignments for files with unsaved
  edits. It passed a constant document version into the analyzer's cache, so the sidebar,
  status bar, and explorer badges could disagree with the editor gutter about the same
  file until the next save.
- Being offline is now reported as GitHub being unreachable instead of telling a
  logged-in user to run `gh auth login`.
- `Check Out Pull Request Branch` goes through `gh pr checkout`, so it works for pull
  requests from forks, whose branches do not exist on `origin`.
- Quiet polls no longer repaint every surface: a sync that returns the same pull requests
  in the same state fires no change event and triggers no rescan.
- HEAD watching now resolves the real `.git` directory, so it works in linked worktrees.
- Walking collisions backwards from a file outside the hot list no longer skips the last
  file.
- Replaced literal NUL bytes in two source files with `\0` escapes. The bytes made git
  and code-search tools treat `store.ts` and `analyzer.ts` as binary; a test now guards
  against raw control bytes in source.
- Removed dead code (`authorIsBot`, the unused `syncing` status, several unused exports)
  and corrected README claims that had drifted from the implementation.

## 0.1.3

- Documented `gitray.maxRegionsPerFile`, which the README settings table had omitted since
  the first release, and rewrote that table so each entry says what the setting does
  instead of trailing off into a fragment.

## 0.1.2

- `gitray.includeOwnPullRequests` now defaults to `true`. Excluding your own work only
  made sense while you were standing on that branch; the moment you switched away, your
  own open pull request was as invisible as anyone else's, and on a repository where you
  are the only author GitRay had nothing to show at all. Set it to `false` for the old
  behaviour.

## 0.1.1

- Fixed the sidebar sitting on "GitRay is starting up." forever. The view had one static
  welcome message and no empty state, so any repository with nothing to track — including
  every repository where you are the only pull request author, since your own are hidden
  by default — looked like an extension that never finished launching. The view now
  reports what it actually found: still starting, nothing to track, or not a git
  repository.

## 0.1.0

First release.

- Collaborator change indicators in the editor gutter, derived from the repository's open
  pull requests: ambient rays, insertion seams, near-miss markers, and collision marks.
- Conflict prediction computed in merge-base coordinates, matching git's own rule that
  overlapping *or adjacent* changes conflict. Verified against real `git merge` runs.
- Hover cards with the pull request, author, a diff of the change, and actions.
- GitRay sidebar with a collisions section and every open pull request.
- Explorer file badges and a status bar summary.
- Radar panel: hot spots ranked by contention, plus a lane per pull request.
- Compare a collaborator's version of a file against yours in a real VS Code diff.
- Offline fixture mode for development.

Metadata comes from the user's own `gh` CLI; all file content is read from local git. One
API request per refresh regardless of pull request count.

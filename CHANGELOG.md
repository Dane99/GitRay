# Changelog

## 0.1.1

- `gitray.includeOwnPullRequests` now defaults to `true`. Excluding your own work only
  made sense while you were standing on that branch; the moment you switched away, your
  own open pull request was as invisible as anyone else's, and on a repository where you
  are the only author GitRay had nothing to show at all. Set it to `false` for the old
  behaviour.
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

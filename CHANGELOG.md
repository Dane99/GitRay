# Changelog

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

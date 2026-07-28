# Changelog

## 0.1.10

- **Hover links land on the file, not at the top of the pull request.** "Open PR" opened the
  discussion and left you to find the file you had just been reading, in a diff that might
  be forty files long — the one action on the card that made you redo work the card had
  already done for you. GitHub names each file on a Files tab with an anchor derived from
  the sha256 of its path, so the destination is computable without asking GitHub anything:
  the link now opens that file's changes directly, and so does `Open #N` on merged work.
  - The anchor matches only when your checkout and the diff spell the path the same way, so
    a rename between them misses — the pull request renaming the file itself, or a rename
    landed since it merged. Either way the browser stays at the top of the Files tab, which
    is where the link used to land. The miss costs a scroll, never a wrong destination.
  - Only the surfaces that are about a file pass one. Opening a pull request from the
    palette or from its row in the sidebar still opens the pull request, rather than
    guessing a file from whichever editor happens to be focused.

## 0.1.9

- **The fork workflow works.** `origin` was hardcoded everywhere a remote was needed, which
  is the wrong remote for the setup GitRay is most useful in: fork a repository and `origin`
  is *your* copy, while the pull requests and the mainline live on `upstream`. Neither half
  failed out loud. `refs/pull/*` does not exist on a fork, so head fetches found nothing and
  line-level indicators never appeared; a fork's default branch is frozen wherever its last
  sync left it, so drift measured as zero. `gh` resolved the base repository correctly the
  whole time, which made the extension half-work — harder to notice than an outright failure.
  - GitRay now works the remote out instead of assuming one. `gitray.remote` decides when it
    is set; otherwise the remote pointing at whatever repository `gh` resolved, since gh
    already does fork base-repo resolution including `gh repo set-default`; otherwise the
    name preference gh itself falls back to — `upstream`, then `github`, then `origin`.
  - `gitray.remote` is honoured even when it names a remote that does not exist. The sidebar
    says which name was not found rather than quietly falling back to one that answers,
    because on a plain clone that fallback is indistinguishable from a working setup.
  - The editor's GitHub session now asks about the same repository the refs are fetched from.
    Previously it parsed `origin` while gh resolved the base repo, so the two transports
    could describe different repositories on the same machine.
  - A failed head fetch names the remote it tried and points at `gitray.remote`, which is
    what the fork case looks like from the outside. Without `gh` the same typo is reported
    at the probe instead, and it names the setting there too rather than reporting itself as
    "no GitHub repository" and sending the reader to look at their remotes.
  - Both fixes work without a reload. Repointing `gitray.remote` re-probes, so the metadata
    follows the refs instead of listing pull requests from the repository it settled on at
    startup; and the remote list is re-read every pass, so `git remote add upstream …` — the
    fix the failure message asks for — takes effect on the next refresh.
  - The host is compared alongside `owner/name` when matching a remote to what `gh`
    resolved, so an Enterprise repository is not satisfied by a public mirror of the same
    name. `gh repo view` reports it in the request GitRay was already making.
  - Nothing in the git layer defaults to `origin` any more — every remote is passed in, so
    the assumption cannot quietly return. `scripts/demo-collision.ts` resolves it the same
    way the extension does.

## 0.1.8

- **The GitHub CLI is no longer required.** It was the largest thing standing between
  installing GitRay and seeing anything: a user without `gh` got a sidebar row telling them
  to go and install a CLI, for the sake of one metadata request per minute. VS Code already
  ships a GitHub authentication provider, and GitRay now falls back to it.
  - `gh` is still preferred whenever it is installed and logged in. It costs GitRay no
    permission of its own and it already understands Enterprise hosts, host config, and
    fork base repositories — none of which a parsed `origin` URL knows about.
  - The fallback asks GitHub's GraphQL API for exactly the fields `gh pr list --json` asks
    for, so both transports produce the same pull requests, sorted and trimmed identically.
    It is still one request per refresh, still 1 GraphQL point, still metadata only.
  - `gitray.maxPullRequests` now stops at 100 rather than 200, and is clamped to it rather
    than merely validated. One request returns one page of a hundred, and GitRay does not
    paginate; the old ceiling was a setting that could only be honoured on machines with
    `gh`, which is the same repository showing two different numbers on two machines.
  - No token is stored. It is borrowed from the editor's session for the length of one
    request. Nothing on a timer can open a sign-in dialog: the silent lookup is the only
    one polling ever makes, and the interactive one lives behind an explicit command.
  - Being signed out is now an actionable sidebar row rather than an instruction —
    clicking it runs `GitRay: Sign in to GitHub`, and the next refresh follows immediately.
  - Two things still need `gh`, and both say so plainly instead of failing: GitHub
    Enterprise hosts, because the editor's provider signs in to github.com only, and
    *Check Out Pull Request Branch*, because checking out a fork head needs a ref that does
    not exist on `origin` and a push configuration a local branch would get wrong. The
    checkout gate asks whether gh can actually act, not merely whether it is installed —
    "installed but logged out, with the editor's session carrying the extension" is a state
    the fallback made reachable, and it used to fail with gh's raw stderr in a popup.
  - A session that expires mid-session now re-probes on the next pass rather than surfacing
    as an error, so the CLI can take over from a dead session, or the reverse, with no reload.

## 0.1.7

- **Muting is a whole feature now.** It had grown lopsided in both directions:
  `gitray.mutedAuthors` was read by the sync engine but no command ever wrote it, so muting
  a person meant hand-editing settings.json; and muting a pull request was one click with
  no way back except *Unmute All*, because nothing anywhere showed you what was muted.
  - A collapsed **Muted** section at the bottom of the sidebar lists every muted author and
    pull request, each with an inline unmute button. Muted pull requests keep their title
    and author, so the row can be judged without opening GitHub.
  - Entries GitRay is no longer tracking — a number whose pull request merged long ago —
    still get a row rather than being stranded in the settings forever.
  - Added `GitRay: Mute Author`, `GitRay: Unmute Pull Request`, and `GitRay: Unmute
    Author`. All of them, plus `Mute Pull Request`, now appear in the command palette and
    prompt for their target.
  - Muted logins are stored as GitHub spells them and matched case-insensitively.
- Fixed: commands invoked from a sidebar context menu ignored the row they were invoked
  from. VS Code hands a context menu the tree node, not the argument object the hover card
  passes, so *Mute* on a pull request opened a quick pick asking which pull request you
  meant — having just been told.

## 0.1.6

- **GitRay now flags conflicts with work that has already merged.** Until now only *open*
  pull requests were watched, which left a hole at the worst possible place: the moment a
  colleague's branch merged it vanished from every surface — at exactly the moment its
  overlap with your work stopped being hypothetical and started waiting for you at your
  next rebase. The mainline is now treated as one more collaborator, and the verdict reads
  `main has moved under you`.
  - Marks appear only where the drift meets your own edits. Ambient mainline activity is
    deliberately not drawn: a merged commit is history, and marking every line the mainline
    has moved since you branched would light up half the repository.
  - The hover leads with the commits that landed and says *your next rebase will stop
    here*, and links back to the original pull request when the merge left its number in
    the subject.
  - Drift is plain git, so it keeps working with `gh` missing, unauthenticated, or offline.
  - The sidebar, status bar, explorer badges, and radar all report it, so a day with
    nothing open is no longer a day where GitRay has nothing to say.
  - The mainline is re-read when a pull request leaves the open list — that *is* the merge
    event — and otherwise at most every five minutes.
  - Its copy lives at `refs/gitray/mainline/<branch>`, never `refs/remotes/origin/<branch>`:
    advancing the latter would make `git status` start reporting a "behind" count you did
    not ask for.
  - Configurable with `gitray.mainline.trackDrift` and `gitray.mainline.branch`.
- Added `GitRay: Compare With the Mainline`, which diffs a file against the exact commit
  the indicators were computed from.

## 0.1.5

- Documented what `ambient` and `collisionsOnly` each show and hide — including that
  `collisionsOnly` still shows near misses — in a README section the settings table now
  links to.

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

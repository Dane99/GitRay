# GitRay

See what your collaborators are changing, before git tells you.

GitRay reads your repository's open pull requests and draws them into your editor: a quiet
ray in the gutter on lines a teammate is editing, escalating to a distinct collision mark
when their work and yours overlap. It watches the mainline too, so a branch that merges
does not vanish from view at the moment its overlap with your work becomes real. The goal
is to move conflict discovery from merge time to write time, so a team can keep more
branches in flight without paying for it later.

Nothing is sent anywhere. GitRay reads pull request metadata with credentials already on
your machine — your `gh` CLI, or the GitHub sign-in VS Code already holds — and your local
`git` for everything else.

---

## How it decides something is a conflict

This is the part worth trusting or not trusting, so here is exactly what happens.

For each open pull request `P` and file `F`:

1. **Find the common ancestor.** `git merge-base HEAD refs/gitray/pr/<P>` — the commit you
   and they both branched from.
2. **Get their changes in ancestor coordinates.** `git diff --unified=0 <base> <their head>`.
   Zero context lines, so each hunk is the minimal set of lines they actually touched.
3. **Get your changes.** Diff your live editor buffer — including unsaved edits — against
   the point where *your branch left the mainline*, then express those ranges in the
   ancestor's coordinates.
4. **Compare.** Two changes collide when their ancestor ranges overlap **or touch**. That
   is the same rule git's three-way merge applies, which is why the prediction matches
   what you get when you actually merge.
5. **Draw.** Their ranges are mapped into your buffer, so indicators stay anchored as you
   type above them.

### What counts as "your work"

Step 3 measures against the mainline (`<remote>/<base branch>`), not against the pull
request's merge base, and the distinction matters more than it looks.

Main keeps moving after a pull request branches off. Diff a file against that pull
request's merge base and every commit that has landed since counts as a local change — so
a freshly cloned, completely untouched checkout would report collisions with work nobody
on this machine has done. During development this repo produced **24 phantom collisions on
a clean tree**; measuring from the mainline instead correctly reports none, and still
reports exactly one when a genuinely overlapping edit is made.

Those upstream overlaps are real conflicts — for the pull request's author to rebase away.
They are not yours, so GitRay does not put them in your gutter.

If the base branch has no remote-tracking ref, GitRay falls back to the merge base and
accepts the extra noise rather than going silent.

### When the pull request has already merged

Everything above is about *open* pull requests, which leaves a hole: the moment a
colleague's branch merges it disappears from the open list — at exactly the moment its
overlap with your work stops being hypothetical and starts waiting for you at your next
rebase. Tracking only what is open means going quiet precisely when the predicted risk
becomes real.

So GitRay treats the mainline as one more collaborator. It keeps its own copy of the branch
at `refs/gitray/mainline/<branch>` and diffs the range you have not caught up on:

```
<where your branch left the mainline>  ..  <where the mainline is now>
```

That first commit is the same one step 3 already uses to decide what counts as your work,
so the two sets of ranges are in the same coordinate system for free — the drift check
costs one `git diff` and reuses an alignment that had to be computed anyway. From there the
comparison is identical to a pull request's, and the verdict reads `main has moved under
you`.

Two things are deliberately different:

- **Ambient drift is not drawn.** An open pull request earns a quiet ray because someone is
  working there and might yet move. A merged commit is history: marking every line the
  mainline has moved since you branched would light up half the repository with changes
  that have nothing to do with you. Mainline marks appear only where the drift meets your
  own edits — as a near miss or a collision, never as texture.
- **It keeps working when the rest of GitRay cannot.** Drift is plain git, so it survives
  missing credentials, an expired login, and a flight with no wifi.
- **Muting does not apply.** [Muting](#muting) hides open pull requests. Once something has
  merged it is in your future regardless of who wrote it, so drift ignores both lists.

The mainline is re-read when a pull request leaves the open list — that *is* the merge
event — and otherwise at most every five minutes, which covers a direct push to `main`.
Its ref lives in the same isolated namespace as everything else: your `refs/remotes/*` are
untouched, so `git status` never starts reporting a "behind" count you did not ask for.

Adjacency counts as a collision, not a near miss. Two edits that meet at a seam with no
line between them make git stop and ask — [verified against real merges in the test
suite](test/integration/gitPipeline.test.ts).

Everything after step 1 is local. There is no server and no telemetry. GitRay stores no
credentials of its own: step 1 runs through `gh`, or through a token the editor hands over
for the length of one request and GitRay never writes down.

## Reading the indicators

| Mark | Meaning |
| --- | --- |
| `│` thin ray in the gutter | A collaborator changed these lines. No conflict with your work. |
| `▸` wedge | They inserted lines at this seam. It occupies no line in your copy, so it points at the boundary instead. |
| `◇` hollow diamond | Their change is within a few lines of yours. Worth knowing about. |
| `◆` filled diamond + tinted line | Their change overlaps or touches yours. Merging will need a decision. |

Mainline drift uses the same near-miss and collision shapes in a reserved neutral hue, so
"this already merged" never reads as one more person with a branch open. Its hover leads
with the commits that landed and says *your next rebase will stop here* rather than
*merging will need a decision* — the difference between something that has happened and
something that might.

Each collaborator gets a stable hue derived from their login, so you learn who is who. When
several people touch one line the ray splits into stacked segments. Hovering any marked
line gives the pull request, the author, a diff of their change, and one-click actions —
including **Open PR**, which opens that file's changes on GitHub rather than the top of a
discussion you would then have to search.

The only filled shape in the set is the collision mark — the one state that means *look
now* — so it stays legible even without color.

### How much the editor shows: `ambient` vs `collisionsOnly`

`gitray.decorations.mode` decides how much of that vocabulary the editor actually uses.
The split is by severity: every change is classified as *ambient* (nowhere near your
work), a *near miss* (within `gitray.proximityLines` of an edit of yours), or a
*collision* (overlaps or touches one).

- **`ambient`** (the default) draws all three. The quiet rays and seam wedges are the
  point of this mode: they are what lets you notice a teammate drifting toward your part
  of a file while the distance is still comfortable, and they are deliberately dimmed so
  they read as texture, not as alerts. Near misses and collisions render on top of that
  layer, exactly as in the table above.
- **`collisionsOnly`** drops the ambient layer and keeps everything that involves *you*.
  Despite the name, that includes near misses — the hollow diamond still appears when a
  change lands within the proximity window — because "about to overlap" is a warning, not
  ambience. What disappears is every mark for changes that are far from your own edits:
  no rays, no seam wedges, and therefore no hover cards on those lines, since a hover
  needs a decorated line to attach to.

Things that do **not** change between the two modes:

- Collisions look identical — same filled diamond, tinted line, ruler mark, and
  end-of-line annotation. Neither mode makes a real conflict quieter.
- Everything outside the editor is unaffected. The sidebar, explorer badges, status bar,
  and radar always reflect all tracked activity, so in `collisionsOnly` they are where
  you go to see what the ambient layer would have told you.
- `Alt+F8` / `Shift+Alt+F8` still walk every collision, in files decorated or not.

A reasonable way to choose: stay on `ambient` until the rays stop being information —
a repository with heavy churn, a file everyone touches — and switch to `collisionsOnly`
there rather than turning the extension `off`, since the warnings you actually act on
are identical in both. `GitRay: Toggle Editor Indicators` cycles
ambient → collisions only → off from the command palette.

## Surfaces

- **Editor** — gutter rays, overview-ruler ticks, collision tinting, hover cards, and a
  sparse end-of-line annotation on collisions and on the region under your cursor.
  `Alt+F8` / `Shift+Alt+F8` walk between collisions across the whole branch.
- **GitRay sidebar** — `main has moved under you` when the mainline is ahead, then
  *Collisions* (hidden entirely when empty), then every open pull request with its files,
  and finally *Muted* — collapsed, and only when something is muted.
- **Explorer badges** — collaborator count per file, `↧` when something that already merged
  touches it, or `⟂` when either collides with you. Folders inherit the badge, so a
  collapsed tree still shows where the activity is.
- **Status bar** — `$(radio-tower) 5 $(git-merge) 12 ⟂ 2`: open pull requests, commits the
  mainline is ahead by, collisions. Each part is dropped when it is zero, and the item
  takes a warning background only when something actually overlaps your work.
- **Radar** (`GitRay: Open Radar`) — the whole repository on one screen. *Hot spots* ranks
  files by how contested they are, including files whose only claimant already merged;
  *Lanes* shows each pull request as a row of file blocks sized by change volume.
- **Compare** — open a real VS Code diff of a collaborator's version of a file, or the
  mainline's, against yours — served from the local ref.

### Muting

Mute a pull request from its row in the sidebar, from its hover card, or with `GitRay: Mute
Pull Request`; mute a person with `GitRay: Mute Author` or from the context menu of any of
their rows.

Everything muted collects in the **Muted** section at the bottom of the sidebar — collapsed,
and absent entirely when there is nothing in it — with an inline button to unmute each
entry. Muted pull requests keep their title and author there, so the row can be judged on
its own; a number GitRay is no longer tracking, because its pull request merged months ago,
still gets a row rather than being stranded in your settings. `GitRay: Unmute All Pull
Requests and Authors` clears both lists at once.

Muting applies to open pull requests only. Once something has merged it is in your future
regardless of who wrote it, so mainline drift ignores both lists.

## Requirements

- `git`, with a full (non-shallow) clone
- VS Code 1.90+
- A way to read GitHub metadata, either of:
  - VS Code's own GitHub sign-in — nothing to install; the sidebar offers it when needed
  - [GitHub CLI](https://cli.github.com/) (`gh`), authenticated — `gh auth login`

`gh` is used whenever it is installed and logged in: it costs GitRay no permission of its
own, and it already understands GitHub Enterprise hosts and fork base repositories. Without
it, GitRay borrows the editor's GitHub session for the same single metadata request. The
token is held for the duration of that request and never stored, and GitRay only ever reads.

Two things still need `gh`: GitHub Enterprise hosts, because VS Code's built-in provider
signs in to github.com only, and *Check Out Pull Request Branch*, because checking out a
fork head needs a ref that does not exist on your own remote.

GitRay degrades rather than disappearing. Without credentials, a GitHub remote, or full
history it falls back to file-level indicators and states the reason in the sidebar instead
of throwing a notification at you every minute.

### Which remote GitRay uses

`origin` is not assumed. In the usual open-source setup `origin` is *your fork* and the
pull requests live on `upstream` — fetch `refs/pull/*` from the fork and you get nothing,
and compare against the fork's `main` and you find no drift. So GitRay works the remote out,
in this order:

1. `gitray.remote`, if you set it. Set it to a remote that does not exist and the sidebar
   says so, rather than quietly falling back to something that answers.
2. The remote pointing at whatever repository `gh` resolved. `gh` already does fork
   base-repo resolution, including `gh repo set-default`, so when it is available its
   answer decides.
3. Otherwise the same name preference `gh` uses: `upstream`, then `github`, then `origin`.

The chosen remote is named in the log (*GitRay: Show Log*) and in the sidebar whenever a
fetch from it fails, which is what a wrong guess looks like. Both fixes take effect on the
next refresh — changing `gitray.remote` and running `git remote add upstream …` are each
noticed without reloading the window.

## What it does to your repository

GitRay fetches open pull request heads, and the mainline, so it can diff them locally:

```
git fetch --no-tags <remote> +refs/pull/142/head:refs/gitray/pr/142 ...
git fetch --no-tags <remote> +refs/heads/main:refs/gitray/mainline/main
```

`<remote>` is whichever remote hosts the pull requests — see
[Which remote GitRay uses](#which-remote-gitray-uses).

To be explicit, because it is the reasonable worry:

- **Fetching is not syncing.** No merge, no rebase, no checkout, no staging. `HEAD`, your
  working tree, `refs/heads/*`, and your remote-tracking refs are never touched, and
  nothing is ever pushed.
- **You do not need to be up to date with anyone.** The `merge-base` computation exists
  precisely to handle two branches that have diverged — that is the case worth warning
  about.
- **Only open pull requests, and only what is missing.** Each `refs/gitray/pr/<n>` is
  checked against the pull request's current head first, so a poll where nobody pushed
  transfers nothing at all. Branches without a pull request are never fetched, apart from
  the one mainline.
- **Isolated namespace.** Everything lands under `refs/gitray/*`: invisible to
  `git branch`, pruned when a pull request closes. In particular the mainline copy is
  *not* `refs/remotes/<remote>/main` — advancing that would change what `git status` and
  every other tool reports, which is your call to make and not an extension's side effect.
- **Fork pull requests work**, since GitHub publishes fork heads under the base repo's
  `refs/pull/*`.

Undo it completely with `GitRay: Remove Local GitRay Refs`, or by hand:

```sh
git for-each-ref --format='delete %(refname)' refs/gitray | git update-ref --stdin
```

Set `gitray.fetchPullRequestRefs` to `false` to skip fetching entirely and keep file-level
indicators only.

### API cost

One metadata call per refresh, regardless of how many pull requests are open — the
per-file data arrives in the same payload, and both transports ask GitHub's GraphQL API for
the same fields, because that is what `gh pr list --json` does too. Measured at **1 GraphQL
point** against a
5000/hour budget, so a full day at the default 60-second interval costs roughly 480 points.
That is GitHub's GraphQL bucket, which is separate from the REST bucket your other tools
use, so GitRay does not compete with them.

Polling each pull request's diff instead would cost ~1,800 requests/hour at 30 open pull
requests. Avoiding that is the reason file content comes from local git.

Polling pauses while the VS Code window is unfocused, and backs off exponentially to ten
minutes if the remote is unreachable.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `gitray.refreshInterval` | `60` | Seconds between refreshes. `0` refreshes only when you ask. |
| `gitray.decorations.mode` | `ambient` | How much to draw in the editor: `ambient`, `collisionsOnly`, or `off`. The difference is spelled out in [How much the editor shows](#how-much-the-editor-shows-ambient-vs-collisionsonly). |
| `gitray.decorations.showInlineAnnotations` | `true` | Show a dim end-of-line note on collisions and on the region under your cursor. |
| `gitray.proximityLines` | `3` | How many lines from your own edit still counts as a near miss. |
| `gitray.includeDrafts` | `false` | Include draft pull requests. |
| `gitray.includeOwnPullRequests` | `true` | Include pull requests you authored. Turn off to see only other people's work. |
| `gitray.maxPullRequests` | `30` | How many open pull requests to track, most recently updated first. Capped at 100 — one request's worth, which is what keeps a refresh costing one request. |
| `gitray.fetchPullRequestRefs` | `true` | Fetch pull request heads into `refs/gitray/*` so indicators can be line-level. Never merges, rebases, or checks anything out. |
| `gitray.remote` | `""` | Remote to fetch pull request heads and the mainline from. Empty means detect it — see [Which remote GitRay uses](#which-remote-gitray-uses). |
| `gitray.mainline.trackDrift` | `true` | Flag work that already merged into the mainline and touches your lines. See [When the pull request has already merged](#when-the-pull-request-has-already-merged). |
| `gitray.mainline.branch` | `""` | Branch to treat as the mainline. Empty means the remote's default branch, falling back to whatever your open pull requests target. |
| `gitray.mutedPullRequests` / `gitray.mutedAuthors` | `[]` | Pull request numbers and GitHub logins to hide. Usually written for you by the mute commands and reviewable in the sidebar's [Muted](#muting) section. Applies to open pull requests only — muting does not suppress mainline drift, since your next rebase does not care who you muted. |
| `gitray.ignoreGlobs` | lockfiles, `dist/**`, minified assets | Files matching these globs never get indicators. |
| `gitray.maxRegionsPerFile` | `400` | Cap on tracked change regions per file. Files past the cap fall back to a file-level indicator. |

`GitRay: Toggle Editor Indicators` cycles ambient → collisions only → off, so "quiet but
still warn me" is one keystroke away.

## Development

```sh
npm install
npm run bundle     # or: npm run watch
npm test
npm run check      # typecheck + lint + test
```

Press `F5` to launch an Extension Development Host.

### Trying it on a real repository

GitRay needs a repo with open pull requests, but you do **not** need write access or pull
requests of your own — clone anything busy and edit it locally:

```sh
git clone https://github.com/expressjs/express.git gitray-testbed
```

Open that clone in the Extension Development Host and the ambient surfaces populate right
away: ~30 lanes in the Radar, explorer badges, and gutter rays on files people are working
on. To see the collision treatment, have the helper edit a line an open pull request
actually changes:

```sh
npx tsx scripts/demo-collision.ts ../gitray-testbed
# ...open the file it names, then undo with:
npx tsx scripts/demo-collision.ts ../gitray-testbed --revert
```

The helper maps the hunk from merge-base coordinates into your checkout's, because the two
drift apart as the base branch moves — editing at the raw hunk line number usually lands
somewhere unrelated.

**Offline mode.** `GitRay: Developer: Load Offline Fixture` loads a JSON pull request set
in place of any GitHub call, so every surface can be exercised — and the design iterated on — with no
network and no open pull requests. A sample lives in [`fixtures/sample.json`](fixtures/sample.json).

### Test layout

- `test/unit/` — the algorithms: hunk parsing, line mapping, collision classification, hue
  assignment, glob matching, plus a manifest-consistency check that cross-references
  `package.json` against the source.
- `test/integration/gitPipeline.test.ts` — builds real repositories and checks GitRay's
  predictions against what `git merge` actually does.
- `test/integration/upstreamDrift.test.ts` — pins down the "your work" definition above, so
  a clean checkout can never start reporting phantom collisions again.
- `test/integration/forkRemote.test.ts` — builds a real fork clone, with the pull requests
  on `upstream` and a stale `origin`, and asserts which remote each fetch reaches. Both
  failures it guards are silent ones.
- `test/integration/activation.test.ts` — activates the real bundle against a stubbed
  VS Code API. This one found a live feedback loop between the scanner and the store during
  development; it is worth keeping.

## License

MIT

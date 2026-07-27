# GitRay

See what your collaborators are changing, before git tells you.

GitRay reads your repository's open pull requests and draws them into your editor: a quiet
ray in the gutter on lines a teammate is editing, escalating to a distinct collision mark
when their work and yours overlap. The goal is to move conflict discovery from merge time
to write time, so a team can keep more branches in flight without paying for it later.

Nothing is sent anywhere. GitRay uses your own `gh` CLI for pull request metadata and your
local `git` for everything else.

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

Step 3 measures against the mainline (`origin/<base branch>`), not against the pull
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

Adjacency counts as a collision, not a near miss. Two edits that meet at a seam with no
line between them make git stop and ask — [verified against real merges in the test
suite](test/integration/gitPipeline.test.ts).

Everything after step 1 is local. There is no server, no telemetry, and no token handling.

## Reading the indicators

| Mark | Meaning |
| --- | --- |
| `│` thin ray in the gutter | A collaborator changed these lines. No conflict with your work. |
| `▸` wedge | They inserted lines at this seam. It occupies no line in your copy, so it points at the boundary instead. |
| `◇` hollow diamond | Their change is within a few lines of yours. Worth knowing about. |
| `◆` filled diamond + tinted line | Their change overlaps or touches yours. Merging will need a decision. |

Each collaborator gets a stable hue derived from their login, so you learn who is who. When
several people touch one line the ray splits into stacked segments. Hovering any marked
line gives the pull request, the author, a diff of their change, and one-click actions.

The only filled shape in the set is the collision mark — the one state that means *look
now* — so it stays legible even without color.

## Surfaces

- **Editor** — gutter rays, overview-ruler ticks, collision tinting, hover cards, and a
  sparse end-of-line annotation on collisions and on the region under your cursor.
  `Alt+F8` / `Shift+Alt+F8` walk between collisions across the whole branch.
- **GitRay sidebar** — *Collisions* first (hidden entirely when empty), then every open
  pull request with its files.
- **Explorer badges** — collaborator count per file, or `⟂` when it collides with you.
  Folders inherit the badge, so a collapsed tree still shows where the activity is.
- **Status bar** — `$(radio-tower) 5 · ⟂ 2`, taking a warning background only when
  something actually overlaps your work.
- **Radar** (`GitRay: Open Radar`) — the whole repository on one screen. *Hot spots* ranks
  files by how contested they are; *Lanes* shows each pull request as a row of file blocks
  sized by change volume.
- **Compare** — open a real VS Code diff of a collaborator's version of a file against
  yours, served from the fetched ref.

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated — `gh auth login`
- `git`, with a full (non-shallow) clone
- VS Code 1.90+

GitRay degrades rather than disappearing. Without `gh`, a GitHub remote, or full history it
falls back to file-level indicators and states the reason in the sidebar instead of
throwing a notification at you every minute.

## What it does to your repository

GitRay fetches open pull request heads so it can diff them locally:

```
git fetch --no-tags --prune origin +refs/pull/142/head:refs/gitray/pr/142 ...
```

To be explicit, because it is the reasonable worry:

- **Fetching is not syncing.** No merge, no rebase, no checkout, no staging. `HEAD`, your
  working tree, `refs/heads/*`, and your remote-tracking refs are never touched, and
  nothing is ever pushed.
- **You do not need to be up to date with anyone.** The `merge-base` computation exists
  precisely to handle two branches that have diverged — that is the case worth warning
  about.
- **Only open pull requests, and only what is missing.** Each `refs/gitray/pr/<n>` is
  checked against the pull request's current head first, so a poll where nobody pushed
  transfers nothing at all. Branches without a pull request are never fetched.
- **Isolated namespace.** Everything lands under `refs/gitray/*`: invisible to
  `git branch`, pruned when a pull request closes.
- **Fork pull requests work**, since GitHub publishes fork heads under the base repo's
  `refs/pull/*`.

Undo it completely with `GitRay: Remove Local GitRay Refs`, or by hand:

```sh
git for-each-ref --format='delete %(refname)' refs/gitray | git update-ref --stdin
```

Set `gitray.fetchPullRequestRefs` to `false` to skip fetching entirely and keep file-level
indicators only.

### API cost

One `gh pr list` call per refresh, regardless of how many pull requests are open — the
per-file data arrives in the same payload. Measured at **1 GraphQL point** against a
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
| `gitray.decorations.mode` | `ambient` | How much to draw in the editor: `ambient`, `collisionsOnly`, or `off`. |
| `gitray.decorations.showInlineAnnotations` | `true` | Show a dim end-of-line note on collisions and on the region under your cursor. |
| `gitray.proximityLines` | `3` | How many lines from your own edit still counts as a near miss. |
| `gitray.includeDrafts` | `false` | Include draft pull requests. |
| `gitray.includeOwnPullRequests` | `true` | Include pull requests you authored. Turn off to see only other people's work. |
| `gitray.maxPullRequests` | `30` | How many open pull requests to track, most recently updated first. |
| `gitray.fetchPullRequestRefs` | `true` | Fetch pull request heads into `refs/gitray/*` so indicators can be line-level. Never merges, rebases, or checks anything out. |
| `gitray.mutedPullRequests` / `gitray.mutedAuthors` | `[]` | Pull request numbers and GitHub logins to hide. |
| `gitray.ignoreGlobs` | lockfiles, `dist/**`, minified assets | Files matching these globs never get indicators. |
| `gitray.maxRegionsPerFile` | `400` | Cap on tracked change regions per file. Files past the cap fall back to a file-level indicator. |

`GitRay: Toggle Editor Indicators` cycles ambient → collisions only → off, so "quiet but
still warn me" is one keystroke away.

## Development

```sh
npm install
npm run bundle     # or: npm run watch
npm test           # 91 tests
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
in place of `gh`, so every surface can be exercised — and the design iterated on — with no
network and no open pull requests. A sample lives in [`fixtures/sample.json`](fixtures/sample.json).

### Test layout

- `test/unit/` — the algorithms: hunk parsing, line mapping, collision classification, hue
  assignment, glob matching, plus a manifest-consistency check that cross-references
  `package.json` against the source.
- `test/integration/gitPipeline.test.ts` — builds real repositories and checks GitRay's
  predictions against what `git merge` actually does.
- `test/integration/upstreamDrift.test.ts` — pins down the "your work" definition above, so
  a clean checkout can never start reporting phantom collisions again.
- `test/integration/activation.test.ts` — activates the real bundle against a stubbed
  VS Code API. This one found a live feedback loop between the scanner and the store during
  development; it is worth keeping.

## License

MIT

# Real-world performance runs

`npm run perf` runs the real extension, from `src/`, against large public GitHub
repositories, and checks that it stays out of a developer's way. It is the check to run
before a release, and the tool to reach for when someone says GitRay is slow.

```
npm run perf                          every default testbed, this working tree
npm run perf -- --testbed vscode      one testbed (comma-separate for several)
npm run perf -- --all                 the stress testbeds too
npm run perf -- --src main            measure another build: any git ref
npm run perf -- --compare <summary>   show the change against an earlier run
npm run perf -- --profile             write a CPU profile of every phase
npm run perf -- --refresh             re-record the open pull requests
npm run perf -- --live                use the real GitHub API and network
npm run perf -- --list                list the testbeds
```

The exit code is non-zero when any phase goes over budget or any stability check fails.

## Testbeds

| id | repository | stresses |
|---|---|---|
| `react` | facebook/react | a mid-sized monorepo; the quickest full run |
| `vscode` | microsoft/vscode | thousands of open pull requests over large, busy files |
| `kubernetes` | kubernetes/kubernetes | a very large working tree |
| `typescript` (stress) | microsoft/TypeScript | files tens of thousands of lines long |

The first run of each testbed clones it with full history, which is a gigabyte or more
and a few minutes. Everything lives under `%LOCALAPPDATA%\gitray-perf` (or
`~/.cache/gitray-perf`), or wherever `GITRAY_PERF_DIR` points: clones, recordings,
results, logs, and profiles. Nothing is written inside the project.

Recording the open pull requests needs a GitHub token, taken from `GITHUB_TOKEN` or from
`gh auth token`. Only the first run of a testbed, `--refresh`, and `--live` need one.

## What a run does

Each testbed runs in a process of its own, through a developer's day in order:

| phase | what happens |
|---|---|
| `startup` | the window opens: discovery, the first sync, fetching every pull request head, the first scan |
| `idle-poll` | a scheduled poll that finds nothing new |
| `refresh` | the Refresh command |
| `open-file` | opening the file with the most collisions, at a colliding line |
| `typing` | 60 keystrokes at about twelve a second |
| `cursor` | 100 cursor moves through the file and back |
| `save` | saving the typed changes |
| `commit` | committing everything, which moves HEAD and every merge base |

Each phase is measured from its trigger until the extension has stopped reacting to it,
including the debounced work it sets off.

### The scenario

"You" are on a branch 40 commits behind the testbed's default branch, so there is
mainline drift to find. Edits are planted in the files the most open pull requests touch,
on a line one of those pull requests changes, so there are collisions. Half of the edited
files are committed on the branch and half are left in the working tree, because GitRay
reads the two differently. The branch is rebuilt from scratch before every run.

### Why it is repeatable

The open pull request list is recorded once and replayed: GitHub's answer to GitRay's own
query, stored verbatim, with each head pinned to the commit that was fetched at recording
time. The testbed's default branch is pinned the same way. GitRay's `origin` is pointed at
the clone itself, so its fetches are real `git fetch` processes that find everything
already local. Two runs a week apart measure the same work; re-record with `--refresh`.

`--live` drops all of that and talks to GitHub for real. Its numbers include the network
and move from run to run.

## What is measured

- **Max block**: the longest single stretch the extension host's thread was unavailable.
  This is the number that matters. That thread is shared with every other extension and
  with the editor's own requests, so a block there is a freeze the user feels. It is
  measured by how late a 5 ms timer fires. On Windows, timers fire in steps of about
  15.6 ms, so anything below that is the measurement floor, which each run reports.
- **Wall time**: trigger to last piece of work. Mostly waiting on git, which does not
  block anything, but it is how long indicators take to appear.
- **Git processes**, by subcommand. A number that grows with the size of the repository
  is where to look first.
- **Analyses**, **scans**, **syncs**, and **blob reads** started by the phase.
- **Input handler time**: for typing and cursor moves, how long each event handler held
  the thread, as p50, p95, and max.
- **Settle time**: from the last keystroke until the indicators were repainted.
- **Surface cost**: time spent building sidebar rows and answering explorer badge
  queries, simulated the way the workbench asks for them.
- **Heap**, after each phase.

Budgets are in [`testbeds.ts`](testbeds.ts). A testbed can override any of them.

### Stability checks

A run also fails if GitRay stops doing its job under load:

- pull requests load, and line-level indicators are available
- collisions and mainline drift are found
- an idle poll does not rescan
- a refresh over unchanged state finds exactly the same collisions
- the open file is analyzed, and its indicators survive typing and a commit
- the extension deactivates cleanly, and nothing is logged as an error

## Finding out why

`--profile` writes a `.cpuprofile` for every phase into `profiles/` in the cache. Open one
in VS Code, or in Chrome's DevTools under Performance, and the flame chart names the
function that held the thread. Each run also writes the extension's full debug log next
to its results.

To see whether a change helped, run the old build and the new one on the same recording:

```
npm run perf -- --testbed vscode --src main
npm run perf -- --testbed vscode --compare <path to the first run's summary.json>
```

`--src` checks the ref out into a worktree in the cache. Only its `src/` is loaded. The
harness and the VS Code stub always come from this checkout, so both builds are measured
by the same instrument.

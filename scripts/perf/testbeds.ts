/**
 * The repositories the performance harness runs against, and what each must stay within.
 *
 * Each one is chosen for a different way of being large, because GitRay's costs scale
 * along different axes: the number of open pull requests, the number of files in the
 * working tree, and the size of individual files.
 */

export interface Testbed {
  /** Short name, used on the command line and in file names. */
  id: string;
  /** `owner/name` on github.com. */
  repo: string;
  /** The repository's default branch, which is treated as the mainline. */
  branch: string;
  /**
   * First-parent commits behind the mainline tip your branch starts at, so there is
   * mainline drift to find — a branch that is level with main exercises none of it.
   */
  behind: number;
  /** How many of the most contested files get edits planted in them. */
  editedFiles: number;
  /** `gitray.maxPullRequests` for the run. */
  maxPullRequests: number;
  /** `default` testbeds run unless one is named; `stress` ones only when asked for. */
  tier: 'default' | 'stress';
  /** Why this one is here. */
  stresses: string;
  budgets?: Partial<Record<PhaseName, Partial<Budget>>>;
}

export type PhaseName =
  | 'startup'
  | 'idle-poll'
  | 'refresh'
  | 'open-file'
  | 'typing'
  | 'cursor'
  | 'save'
  | 'commit';

/**
 * What a phase must stay within. Any limit left out is not checked.
 *
 * `maxBlockMs` is the one that matters most: it is the longest single stretch the
 * extension host's thread was unavailable, which is the length of the longest freeze a
 * user could have felt — in typing, in hovers, in every other extension. 50 ms is the
 * point at which input lag starts being noticeable.
 */
export interface Budget {
  /** Longest single block of the extension host's thread. */
  maxBlockMs: number;
  /** From the trigger to the last piece of work it set off. */
  wallMs: number;
  /** Git processes started. */
  gitSpawns: number;
  /** For input phases: the slowest 5% of handler calls, in milliseconds. */
  handlerP95Ms: number;
  /** For typing: from the last keystroke until the indicators were repainted. */
  settleMs: number;
}

/**
 * Defaults every testbed is held to.
 *
 * Phases with the network or a cold start in them are allowed more wall time, because that
 * time is spent waiting rather than blocking. None of them is allowed a long block.
 */
export const DEFAULT_BUDGETS: Record<PhaseName, Partial<Budget>> = {
  startup: { maxBlockMs: 150 },
  'idle-poll': { maxBlockMs: 50, wallMs: 1500, gitSpawns: 10 },
  refresh: { maxBlockMs: 100, wallMs: 10_000 },
  'open-file': { maxBlockMs: 100, wallMs: 2_000 },
  typing: { maxBlockMs: 50, handlerP95Ms: 2, settleMs: 1_000 },
  cursor: { maxBlockMs: 50, handlerP95Ms: 2 },
  save: { maxBlockMs: 100, wallMs: 10_000 },
  commit: { maxBlockMs: 150, wallMs: 20_000 }
};

export const TESTBEDS: readonly Testbed[] = [
  {
    id: 'react',
    repo: 'facebook/react',
    branch: 'main',
    behind: 40,
    editedFiles: 25,
    maxPullRequests: 30,
    tier: 'default',
    stresses: 'a mid-sized JavaScript monorepo; the quickest full run'
  },
  {
    id: 'vscode',
    repo: 'microsoft/vscode',
    branch: 'main',
    behind: 40,
    editedFiles: 40,
    maxPullRequests: 100,
    tier: 'default',
    stresses: 'thousands of open pull requests over large, busy TypeScript files'
  },
  {
    id: 'kubernetes',
    repo: 'kubernetes/kubernetes',
    branch: 'master',
    behind: 40,
    editedFiles: 40,
    maxPullRequests: 100,
    tier: 'default',
    stresses: 'a very large working tree, which every working-tree diff has to stat'
  },
  {
    id: 'typescript',
    repo: 'microsoft/TypeScript',
    branch: 'main',
    behind: 40,
    editedFiles: 20,
    maxPullRequests: 100,
    tier: 'stress',
    stresses: 'single files tens of thousands of lines long, such as checker.ts'
  }
];

export function budgetFor(testbed: Testbed, phase: PhaseName): Partial<Budget> {
  return { ...DEFAULT_BUDGETS[phase], ...testbed.budgets?.[phase] };
}

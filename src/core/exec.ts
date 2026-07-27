/**
 * Subprocess helper for git and gh.
 *
 * Every call goes through `execFile` with an argument array — never a shell string — so
 * branch names, paths, and pull request titles coming from a remote repository cannot be
 * interpreted as shell syntax. Interactive prompts are disabled too: a credential helper
 * or pager waiting on stdin would hang the extension host with no visible cause.
 */

import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';

export interface RunOptions {
  cwd: string;
  /** Milliseconds before the process is killed. */
  timeout?: number;
  /** Bytes of stdout to keep before truncating. */
  maxBuffer?: number;
  /** Treat these exit codes as success. Useful for git's "no, but that's an answer" codes. */
  okExitCodes?: number[];
  signal?: AbortSignal;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly code: number,
    readonly stderr: string,
    readonly timedOut: boolean
  ) {
    const detail = stderr.trim().split('\n')[0] || `exit code ${code}`;
    super(`${command} ${args.join(' ')} failed: ${detail}`);
    this.name = 'CommandError';
  }
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Environment tweaks shared by git and gh.
 *
 * `GIT_TERMINAL_PROMPT` and `GH_PROMPT_DISABLED` stop either tool from blocking on a
 * credential prompt. `GIT_OPTIONAL_LOCKS=0` keeps read-only commands from taking the
 * index lock, which would otherwise make GitRay's background polling contend with the
 * user's own git operations.
 */
function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GH_PROMPT_DISABLED: '1',
    GH_PAGER: 'cat',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1'
  };
}

export function run(
  command: string,
  args: readonly string[],
  options: RunOptions
): Promise<RunResult> {
  const execOptions: ExecFileOptions = {
    cwd: options.cwd,
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    env: childEnv(),
    windowsHide: true,
    // Never route through a shell: arguments must stay arguments.
    shell: false
  };
  if (options.signal) {
    execOptions.signal = options.signal;
  }

  return new Promise((resolve, reject) => {
    execFile(command, [...args], execOptions, (error, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
      const err = typeof stderr === 'string' ? stderr : stderr.toString('utf8');

      if (!error) {
        resolve({ stdout: out, stderr: err, code: 0 });
        return;
      }

      const code = typeof (error as { code?: unknown }).code === 'number'
        ? (error as unknown as { code: number }).code
        : 1;

      if (options.okExitCodes?.includes(code)) {
        resolve({ stdout: out, stderr: err, code });
        return;
      }

      const timedOut = (error as { killed?: boolean }).killed === true;
      reject(new CommandError(command, args, code, err || error.message, timedOut));
    });
  });
}

/** Is this executable on PATH? */
export async function isAvailable(command: string, cwd: string): Promise<boolean> {
  try {
    await run(command, ['--version'], { cwd, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

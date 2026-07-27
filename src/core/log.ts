/**
 * Output channel logging.
 *
 * GitRay runs in the background and touches git, so when something goes wrong the user
 * deserves a readable trail rather than a modal. Nothing here is ever shown as a popup.
 */

import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('GitRay', { log: true });
  return channel;
}

export const log = {
  trace(message: string, ...args: unknown[]): void {
    channel?.trace(message, ...args);
  },
  debug(message: string, ...args: unknown[]): void {
    channel?.debug(message, ...args);
  },
  info(message: string, ...args: unknown[]): void {
    channel?.info(message, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    channel?.warn(message, ...args);
  },
  error(message: string, error?: unknown): void {
    if (error instanceof Error) channel?.error(error, message);
    else if (error !== undefined) channel?.error(`${message}: ${String(error)}`);
    else channel?.error(message);
  },
  show(): void {
    channel?.show(true);
  }
};

/** Time an async operation and log how long it took, for tuning the poll loop. */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    log.debug(`${label} took ${Date.now() - started}ms`);
  }
}

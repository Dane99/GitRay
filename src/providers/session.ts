/**
 * The editor's own GitHub sign-in.
 *
 * VS Code ships a GitHub authentication provider and every user of the GitHub extensions
 * already has a session in it. Borrowing that session is what lets GitRay work on a machine
 * without the `gh` CLI, and it keeps the original promise intact: the token is handed over
 * by the editor, held for the duration of one request, and never written anywhere.
 *
 * This is the only file that knows the editor is involved; `GitHubApi` sees a `TokenSource`.
 */

import * as vscode from 'vscode';
import { log } from '../core/log.js';
import type { TokenSource } from './githubApi.js';

const PROVIDER_ID = 'github';

/**
 * Why `repo` and not something smaller.
 *
 * Reading a private repository's pull requests needs it — GitHub has no read-only variant
 * of that grant, and the finer-grained scopes cover none of it. GitRay uses it for exactly
 * two GraphQL queries, both read-only.
 *
 * The cost is that the silent lookup below is all-or-nothing: it matches on scopes, so a
 * session that exists with something narrower returns nothing here, however public the
 * repository is. Asking for less would trade a dialog on some machines for no private
 * repositories on any of them. Whoever is signed in and still seeing the sign-out row is
 * seeing this, and one click through the dialog upgrades their session for good.
 */
const SCOPES = ['repo'];

/** A token source backed by whatever GitHub session the editor already holds. */
export function editorTokenSource(): TokenSource {
  return {
    async getToken({ interactive }): Promise<string | undefined> {
      try {
        const session = await vscode.authentication.getSession(
          PROVIDER_ID,
          SCOPES,
          interactive ? { createIfNone: true } : { silent: true }
        );
        return session?.accessToken;
      } catch (error) {
        // Dismissing the sign-in dialog rejects. That is an answer, not a fault, and it
        // must not take a poll down with it.
        log.debug(
          `no GitHub session: ${error instanceof Error ? error.message : String(error)}`
        );
        return undefined;
      }
    }
  };
}

/**
 * Ask the editor to sign the user in, and say whether they did.
 *
 * Only ever called from the explicit command behind the sidebar's sign-in row — nothing on
 * a timer is allowed to open this dialog.
 */
export async function signIn(): Promise<boolean> {
  try {
    const session = await vscode.authentication.getSession(PROVIDER_ID, SCOPES, {
      createIfNone: true
    });
    if (session) log.info(`signed in to GitHub as ${session.account.label}`);
    return session !== undefined;
  } catch (error) {
    log.debug(`sign-in cancelled: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

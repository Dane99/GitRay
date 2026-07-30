/**
 * The editor's own GitHub sign-in, which is the only way GitRay talks to GitHub.
 *
 * VS Code ships GitHub authentication providers and every user of the GitHub extensions
 * already has a session in one of them. Borrowing that session is what lets GitRay work
 * with nothing installed beyond the editor, and it keeps the original promise intact: the
 * token is handed over by the editor, held for the duration of one request, and never
 * written anywhere.
 *
 * Two providers, because there are two kinds of GitHub. `github` is built in and issues
 * github.com tokens with no setup at all. `github-enterprise` is registered only once the
 * user points `github-enterprise.uri` at their server, and issues tokens for that one host
 * — so it is offered exactly when the remote and that setting agree, and never guessed at.
 *
 * This is the only file that knows the editor is involved; `GitHubApi` sees a `TokenSource`.
 */

import * as vscode from 'vscode';
import { log } from '../core/log.js';
import type { TokenSource } from './githubApi.js';
import { GITHUB_HOST, hostOf } from './remote.js';

const PROVIDER_ID = 'github';
const ENTERPRISE_PROVIDER_ID = 'github-enterprise';

/** The setting the editor's Enterprise provider is itself configured from. */
export const ENTERPRISE_SETTING = 'github-enterprise.uri';

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

/**
 * Which authentication provider issues tokens for a host, if the editor has one at all.
 *
 * Undefined is the honest answer for an Enterprise host nobody has configured: asking the
 * editor for a session from a provider it never registered throws, and offering a sign-in
 * that cannot possibly work is worse than saying what is missing.
 */
export function providerFor(host: string): string | undefined {
  if (host === GITHUB_HOST) return PROVIDER_ID;
  return enterpriseHost() === host ? ENTERPRISE_PROVIDER_ID : undefined;
}

function enterpriseHost(): string | undefined {
  const uri = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri');
  return uri ? hostOf(uri) : undefined;
}

/** A token source backed by whatever GitHub session the editor already holds. */
export function editorTokenSource(): TokenSource {
  return {
    supports(host: string): boolean {
      return providerFor(host) !== undefined;
    },

    async getToken({ host, interactive }): Promise<string | undefined> {
      const providerId = providerFor(host);
      if (!providerId) return undefined;

      try {
        const session = await vscode.authentication.getSession(
          providerId,
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
 * Ask the editor to sign the user in to a host, and say whether they did.
 *
 * Only ever called from the explicit command behind the sidebar's sign-in row — nothing on
 * a timer is allowed to open this dialog.
 */
export async function signIn(host: string = GITHUB_HOST): Promise<boolean> {
  const providerId = providerFor(host);
  if (!providerId) {
    log.warn(`no GitHub sign-in is configured for ${host}; set \`${ENTERPRISE_SETTING}\``);
    return false;
  }

  try {
    const session = await vscode.authentication.getSession(providerId, SCOPES, {
      createIfNone: true
    });
    if (session) log.info(`signed in to ${host} as ${session.account.label}`);
    return session !== undefined;
  } catch (error) {
    log.debug(`sign-in cancelled: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

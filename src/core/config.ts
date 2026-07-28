/**
 * Typed access to the `gitray.*` settings.
 */

import * as vscode from 'vscode';
import { MAX_TRACKED_PULL_REQUESTS } from './types.js';

export type DecorationMode = 'ambient' | 'collisionsOnly' | 'off';

export interface Config {
  refreshInterval: number; // seconds
  includeDrafts: boolean;
  includeOwnPullRequests: boolean;
  maxPullRequests: number;
  proximityLines: number;
  decorationMode: DecorationMode;
  showInlineAnnotations: boolean;
  fetchPullRequestRefs: boolean;
  /** Empty means "detect it". See remoteSelection.ts for what detection does. */
  remote: string;
  trackMainlineDrift: boolean;
  /** Empty means "detect it", which is what almost everyone should leave it as. */
  mainlineBranch: string;
  mutedPullRequests: number[];
  /** As the user wrote them. Compare with `isMutedAuthor`, never with `includes`. */
  mutedAuthors: string[];
  ignoreGlobs: string[];
  maxRegionsPerFile: number;
}

export function readConfig(scope?: vscode.Uri): Config {
  const raw = vscode.workspace.getConfiguration('gitray', scope);
  return {
    refreshInterval: raw.get<number>('refreshInterval', 60),
    includeDrafts: raw.get<boolean>('includeDrafts', false),
    includeOwnPullRequests: raw.get<boolean>('includeOwnPullRequests', true),
    // Clamped, not merely validated: the manifest's `maximum` is advice a settings.json
    // written by hand can ignore, and a value above the page limit is one both transports
    // would answer differently — the CLI paginates internally, the API does not.
    maxPullRequests: Math.min(
      raw.get<number>('maxPullRequests', 30),
      MAX_TRACKED_PULL_REQUESTS
    ),
    proximityLines: raw.get<number>('proximityLines', 3),
    decorationMode: raw.get<DecorationMode>('decorations.mode', 'ambient'),
    showInlineAnnotations: raw.get<boolean>('decorations.showInlineAnnotations', true),
    fetchPullRequestRefs: raw.get<boolean>('fetchPullRequestRefs', true),
    remote: raw.get<string>('remote', '').trim(),
    trackMainlineDrift: raw.get<boolean>('mainline.trackDrift', true),
    mainlineBranch: raw.get<string>('mainline.branch', '').trim(),
    mutedPullRequests: raw.get<number[]>('mutedPullRequests', []),
    mutedAuthors: raw.get<string[]>('mutedAuthors', []),
    ignoreGlobs: raw.get<string[]>('ignoreGlobs', []),
    maxRegionsPerFile: raw.get<number>('maxRegionsPerFile', 400)
  };
}

/**
 * Is this author muted?
 *
 * GitHub logins are case-insensitive, but the setting is hand-editable and the "Mute
 * Author" command writes back whatever casing GitHub reported. Normalizing at the one
 * comparison point keeps the stored list readable while treating a login as the same
 * person however it was typed — including in the tree row that offers to unmute them.
 */
export function isMutedAuthor(config: Config, author: string): boolean {
  const wanted = author.toLowerCase();
  return config.mutedAuthors.some((muted) => muted.toLowerCase() === wanted);
}

/**
 * Write a setting back.
 *
 * The scope decides where it lands, and for the per-repository settings it has to: muting
 * #5 is a statement about one repository's pull request #5, and in a multi-root workspace
 * the workspace-level list is shared by every folder — so a mute made in one repository
 * would silence an unrelated pull request in the next one along. Passing the folder writes
 * it to that folder's own settings instead.
 *
 * With a single folder there is no folder-level target to write to, and the workspace file
 * is that folder's `.vscode/settings.json` anyway, so the distinction does not arise.
 */
export async function updateSetting<T>(
  key: string,
  value: T,
  scope?: vscode.Uri
): Promise<void> {
  const perFolder = scope !== undefined && (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const target = perFolder
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
  await vscode.workspace.getConfiguration('gitray', scope).update(key, value, target);
}

/**
 * Typed access to the `gitray.*` settings.
 */

import * as vscode from 'vscode';

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
    maxPullRequests: raw.get<number>('maxPullRequests', 30),
    proximityLines: raw.get<number>('proximityLines', 3),
    decorationMode: raw.get<DecorationMode>('decorations.mode', 'ambient'),
    showInlineAnnotations: raw.get<boolean>('decorations.showInlineAnnotations', true),
    fetchPullRequestRefs: raw.get<boolean>('fetchPullRequestRefs', true),
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

export async function updateSetting<T>(
  key: string,
  value: T,
  target = vscode.ConfigurationTarget.Workspace
): Promise<void> {
  await vscode.workspace.getConfiguration('gitray').update(key, value, target);
}

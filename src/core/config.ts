/**
 * Typed access to the `gitray.*` settings.
 */

import * as vscode from 'vscode';

export type DecorationMode = 'ambient' | 'collisionsOnly' | 'off';

export interface Config {
  refreshInterval: number;
  includeDrafts: boolean;
  includeOwnPullRequests: boolean;
  maxPullRequests: number;
  proximityLines: number;
  decorationMode: DecorationMode;
  showInlineAnnotations: boolean;
  fetchPullRequestRefs: boolean;
  mutedPullRequests: number[];
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
    mutedPullRequests: raw.get<number[]>('mutedPullRequests', []),
    mutedAuthors: raw.get<string[]>('mutedAuthors', []).map((a) => a.toLowerCase()),
    ignoreGlobs: raw.get<string[]>('ignoreGlobs', []),
    maxRegionsPerFile: raw.get<number>('maxRegionsPerFile', 400)
  };
}

export async function updateSetting<T>(
  key: string,
  value: T,
  target = vscode.ConfigurationTarget.Workspace
): Promise<void> {
  await vscode.workspace.getConfiguration('gitray').update(key, value, target);
}

/** Does a change event touch any setting we care about? */
export function affectsGitRay(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration('gitray');
}

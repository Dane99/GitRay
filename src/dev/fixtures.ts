/**
 * Offline fixture mode.
 *
 * Loads a JSON pull request set in place of GitHub, so every surface can be exercised —
 * and the visual design iterated on — with no network, no GitHub account, and no waiting
 * for a colleague to push something. Line-level indicators still need real refs, so a
 * fixture drives the file-level surfaces: the tree, badges, status bar, and radar.
 */

import * as vscode from 'vscode';
import type { PullRequest } from '../core/types.js';
import { log } from '../core/log.js';

interface FixtureFile {
  path?: string;
  additions?: number;
  deletions?: number;
}

interface FixturePullRequest {
  number?: number;
  title?: string;
  author?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  isDraft?: boolean;
  updatedAt?: string;
  url?: string;
  files?: FixtureFile[];
}

export async function pickFixture(): Promise<PullRequest[] | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Load fixture',
    filters: { 'GitRay fixture': ['json'] },
    title: 'Select a GitRay pull request fixture'
  });

  const uri = picked?.[0];
  if (!uri) return undefined;

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return parseFixture(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    log.error('failed to load fixture', error);
    void vscode.window.showErrorMessage(
      `GitRay: could not load fixture — ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

/**
 * Parse a fixture, filling in whatever the author left out.
 *
 * Written to be forgiving: a fixture is a design tool, and having to specify a plausible
 * SHA and ISO timestamp for every entry would make it a chore to write one by hand.
 */
export function parseFixture(json: string): PullRequest[] {
  const parsed = JSON.parse(json) as unknown;
  const raw: FixturePullRequest[] = Array.isArray(parsed)
    ? (parsed as FixturePullRequest[])
    : ((parsed as { pullRequests?: FixturePullRequest[] }).pullRequests ?? []);

  return raw.map((entry, index) => {
    const number = entry.number ?? index + 1;
    const author = entry.author ?? 'collaborator';

    return {
      number,
      title: entry.title ?? `Fixture pull request #${number}`,
      author,
      headRefName: entry.headRefName ?? `fixture/${number}`,
      headRefOid: entry.headRefOid ?? `fixture${String(number).padStart(36, '0')}`,
      baseRefName: entry.baseRefName ?? 'main',
      isDraft: entry.isDraft === true,
      updatedAt: entry.updatedAt ?? relativeIso(index),
      url: entry.url ?? `https://example.invalid/pull/${number}`,
      additions: sum(entry.files, 'additions'),
      deletions: sum(entry.files, 'deletions'),
      files: (entry.files ?? [])
        .filter((file): file is FixtureFile & { path: string } => typeof file.path === 'string')
        .map((file) => ({
          path: file.path,
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0
        }))
    };
  });
}

function sum(files: FixtureFile[] | undefined, key: 'additions' | 'deletions'): number {
  return (files ?? []).reduce((total, file) => total + (file[key] ?? 0), 0);
}

/** Stagger fixture timestamps so relative times in the UI look plausible. */
function relativeIso(index: number): string {
  return new Date(Date.now() - (index + 1) * 37 * 60_000).toISOString();
}

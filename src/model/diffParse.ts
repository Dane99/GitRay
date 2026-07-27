/**
 * Parser for `git diff --unified=0` output.
 *
 * Zero context is deliberate: it makes every hunk a minimal, precise statement about
 * which base lines were touched, which is exactly what conflict detection needs. With
 * context lines the ranges would be inflated and everything would look like a collision.
 */

import type { ChangeKind, LineRange } from '../core/types.js';

export interface Hunk {
  /** Where the change lands in the base file, 0-based half-open. */
  baseRange: LineRange;
  kind: ChangeKind;
  removed: string[];
  added: string[];
}

export interface FileDiff {
  /** Repo-relative POSIX path in the new tree, or the old path for deletions. */
  path: string;
  /** Set when the file was renamed; the path it came from. */
  oldPath?: string;
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Turn a hunk header's old-side numbers into a 0-based half-open base range.
 *
 * The subtle case is `count === 0`, a pure insertion. Unified diff reports the line
 * *after which* the insertion happens, 1-based, so `@@ -10,0` inserts after base line 10.
 * As a 0-based insertion point that is exactly index 10 — no adjustment needed — while a
 * non-empty range needs the usual 1-based-to-0-based shift.
 */
export function hunkHeaderToBaseRange(oldStart: number, oldCount: number): LineRange {
  if (oldCount === 0) {
    return { start: oldStart, end: oldStart };
  }
  return { start: oldStart - 1, end: oldStart - 1 + oldCount };
}

function classify(removed: string[], added: string[]): ChangeKind {
  if (removed.length === 0) return 'add';
  if (added.length === 0) return 'delete';
  return 'modify';
}

/**
 * Undo git's C-style path quoting. Callers should pass `-c core.quotePath=false` so this
 * rarely fires, but a path containing a literal quote or newline still arrives quoted.
 */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) {
    return raw;
  }
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[++i];
    switch (next) {
      case 'n': bytes.push(0x0a); break;
      case 't': bytes.push(0x09); break;
      case 'r': bytes.push(0x0d); break;
      case 'b': bytes.push(0x08); break;
      case 'f': bytes.push(0x0c); break;
      case 'v': bytes.push(0x0b); break;
      case 'a': bytes.push(0x07); break;
      case '\\': bytes.push(0x5c); break;
      case '"': bytes.push(0x22); break;
      default:
        if (next >= '0' && next <= '7') {
          const octal = body.slice(i, i + 3);
          bytes.push(parseInt(octal, 8));
          i += 2;
        } else {
          bytes.push(...Buffer.from(next ?? '', 'utf8'));
        }
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(raw: string): string {
  const path = unquotePath(raw.trim());
  if (path === '/dev/null') return '';
  // Strip the a/ or b/ prefix git adds by default.
  return /^[ab]\//.test(path) ? path.slice(2) : path;
}

/**
 * Parse a full multi-file unified diff.
 *
 * Tolerant by design: unknown or unexpected lines between hunks are skipped rather than
 * throwing, because git adds new metadata lines over time and a parse failure here would
 * silently blank out every indicator.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = text.split('\n');

  let current: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let removed: string[] = [];
  let added: string[] = [];

  const closeHunk = () => {
    if (!hunk || !current) {
      hunk = undefined;
      return;
    }
    if (removed.length > 0 || added.length > 0) {
      hunk.removed = removed;
      hunk.added = added;
      hunk.kind = classify(removed, added);
      current.hunks.push(hunk);
    }
    hunk = undefined;
    removed = [];
    added = [];
  };

  const closeFile = () => {
    closeHunk();
    if (current && (current.hunks.length > 0 || current.isBinary)) {
      files.push(current);
    }
    current = undefined;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      closeFile();
      current = {
        path: parseDiffGitPath(line),
        isBinary: false,
        isNew: false,
        isDeleted: false,
        hunks: []
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('@@')) {
      closeHunk();
      const match = HUNK_HEADER.exec(line);
      if (!match) continue;
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      hunk = {
        baseRange: hunkHeaderToBaseRange(oldStart, oldCount),
        kind: 'modify',
        removed: [],
        added: []
      };
      continue;
    }

    if (hunk) {
      if (line.startsWith('-')) {
        removed.push(line.slice(1));
      } else if (line.startsWith('+')) {
        added.push(line.slice(1));
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" — carries no line content.
        continue;
      } else {
        // With --unified=0 there is no context, so anything else ends the hunk.
        closeHunk();
      }
      continue;
    }

    if (line.startsWith('--- ')) {
      const path = stripPrefix(line.slice(4));
      if (path === '') current.isNew = true;
      else current.oldPath = path;
    } else if (line.startsWith('+++ ')) {
      const path = stripPrefix(line.slice(4));
      if (path === '') current.isDeleted = true;
      else current.path = path;
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.isBinary = true;
    } else if (line.startsWith('rename from ')) {
      current.oldPath = unquotePath(line.slice('rename from '.length).trim());
    } else if (line.startsWith('rename to ')) {
      current.path = unquotePath(line.slice('rename to '.length).trim());
    }
  }

  closeFile();

  // A rename with no content change carries no hunks; drop the redundant oldPath marker
  // when it matches the new path so downstream code does not treat it as a move.
  for (const file of files) {
    if (file.oldPath === file.path) delete file.oldPath;
  }

  return files;
}

/**
 * Recover the path from a `diff --git a/x b/x` line.
 *
 * Ambiguous when the path contains spaces, since both sides are space-separated. The
 * a/ + b/ prefixes make it solvable: split at the midpoint and verify both halves agree.
 * The `--- ` / `+++ ` lines that follow are authoritative anyway and will overwrite this;
 * this only has to be good enough for binary files, which have no such lines.
 */
function parseDiffGitPath(line: string): string {
  const rest = line.slice('diff --git '.length).trim();

  if (rest.startsWith('"')) {
    const end = findClosingQuote(rest);
    if (end > 0) return stripPrefix(rest.slice(0, end + 1));
  }

  const tokens = rest.split(' ');
  if (tokens.length === 2) {
    return stripPrefix(tokens[1]);
  }

  // Try every split point and take the one where both sides name the same file.
  for (let i = 1; i < tokens.length; i++) {
    const left = stripPrefix(tokens.slice(0, i).join(' '));
    const right = stripPrefix(tokens.slice(i).join(' '));
    if (left !== '' && left === right) return right;
  }

  return stripPrefix(tokens.slice(Math.ceil(tokens.length / 2)).join(' '));
}

function findClosingQuote(text: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '"') return i;
  }
  return -1;
}

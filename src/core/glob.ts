/**
 * Minimal glob matching for the `gitray.ignoreGlobs` setting.
 *
 * VS Code does not export its glob matcher to extensions, and pulling in minimatch for
 * one setting is not worth the bundle. This supports the subset people actually write in
 * an ignore list: `**`, `*`, `?`, and `{a,b}` alternation, over POSIX-separated paths.
 */

const SPECIAL = /[.+^$()|[\]\\]/g;

function translate(pattern: string): RegExp {
  let out = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*') {
      const isDoubleStar = pattern[i + 1] === '*';
      if (isDoubleStar) {
        const followedBySlash = pattern[i + 2] === '/';
        if (followedBySlash) {
          // `**/` matches any number of leading directories, including none, so that
          // `**/*.min.js` also matches a top-level `app.min.js`.
          out += '(?:[^/]*(?:/|$))*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
        continue;
      }
      // A single star stops at a path separator.
      out += '[^/]*';
      i += 1;
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }

    if (char === '{') {
      const close = pattern.indexOf('}', i);
      if (close > i) {
        const alternatives = pattern.slice(i + 1, close).split(',');
        out += `(?:${alternatives.map((alt) => alt.replace(SPECIAL, '\\$&')).join('|')})`;
        i = close + 1;
        continue;
      }
    }

    out += char.replace(SPECIAL, '\\$&');
    i += 1;
  }

  return new RegExp(`^${out}$`);
}

const cache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  let regex = cache.get(pattern);
  if (!regex) {
    regex = translate(pattern);
    cache.set(pattern, regex);
  }
  return regex;
}

/** Does a repo-relative POSIX path match this glob? */
export function matchesGlob(path: string, pattern: string): boolean {
  return compiled(pattern).test(path);
}

/** Does the path match any of these globs? */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

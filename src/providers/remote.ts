/**
 * Which GitHub repository a remote URL points at.
 *
 * The editor's GitHub session hands over a token and nothing else, which leaves the question
 * of *whose* pull requests to ask for. That answer is sitting in a remote URL — which remote
 * is remoteSelection.ts's problem, not this module's.
 *
 * Parsing is deliberately narrow. A URL that does not resolve to a plain `owner/name` on a
 * recognisable host returns undefined, and the caller falls back to saying so — guessing
 * would mean polling a repository nobody asked about.
 */

export interface RemoteRepository {
  /** Lower-cased, without a port, `www.`, or credentials. */
  host: string;
  owner: string;
  name: string;
  /** `owner/name`, the form GitHub itself uses. */
  nameWithOwner: string;
}

/** The host the editor's built-in GitHub provider speaks for without any configuration. */
export const GITHUB_HOST = 'github.com';

/** Owner and repository names GitHub will actually accept. */
const NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Split a git remote URL into host and path.
 *
 * Two syntaxes, because git accepts two: real URLs (`https://`, `ssh://`, `git://`) and
 * the scp-like shorthand (`git@github.com:owner/repo.git`) that every GitHub clone button
 * still offers. The shorthand is not a URL and `new URL()` mangles it into a `git:` scheme
 * with the whole thing as a path, which is how remotes end up silently unrecognised.
 */
function split(url: string): { host: string; path: string } | undefined {
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.*)$/.exec(url);
  if (scheme) {
    const rest = scheme[1];
    const slash = rest.indexOf('/');
    if (slash <= 0) return undefined;
    return { host: rest.slice(0, slash), path: rest.slice(slash + 1) };
  }

  // Shorthand: everything before the first colon is the host, and the colon must not be
  // followed by a slash — `host:/path` is a git-daemon URL, not this.
  const shorthand = /^([^/:]+):(?!\/)(.+)$/.exec(url);
  if (shorthand) {
    return { host: shorthand[1], path: shorthand[2] };
  }

  return undefined;
}

function normaliseHost(raw: string): string {
  // Credentials belong to the transport, not the identity: `https://token@github.com/...`
  // is the same repository as `https://github.com/...`, and the token must not leak into
  // anything that gets logged.
  const at = raw.lastIndexOf('@');
  let host = (at === -1 ? raw : raw.slice(at + 1)).replace(/:\d+$/, '').toLowerCase();

  if (host.startsWith('www.')) host = host.slice(4);
  // GitHub's SSH-over-443 endpoint. Same repositories, different door.
  if (host === 'ssh.github.com') host = GITHUB_HOST;
  return host;
}

/** The repository a remote URL names, or undefined when it does not name one. */
export function parseRemoteUrl(raw: string): RemoteRepository | undefined {
  const parts = split(raw.trim());
  if (!parts) return undefined;

  const host = normaliseHost(parts.host);
  if (!host) return undefined;

  const segments = parts.path
    .replace(/\.git$/, '')
    .split('/')
    .filter((segment) => segment !== '');

  // The last two segments, not the first two: an Enterprise install can sit under a path
  // prefix, and `ssh://git@host:443/owner/repo` puts nothing before them either way.
  if (segments.length < 2) return undefined;
  const [owner, name] = segments.slice(-2);
  if (!NAME.test(owner) || !NAME.test(name)) return undefined;

  return { host, owner, name, nameWithOwner: `${owner}/${name}` };
}

/**
 * The host a bare URL names, normalised the way a remote's host is.
 *
 * For settings rather than remotes — `github-enterprise.uri` is a server address with no
 * repository path on it, so `parseRemoteUrl` rejects it. Comparing the two has to happen
 * after the same normalisation, or a trailing slash or a port decides that the Enterprise
 * server the editor is signed in to is a different one from the remote.
 */
export function hostOf(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.*)$/.exec(trimmed);
  const authority = (scheme ? scheme[1] : trimmed).split('/')[0];
  return normaliseHost(authority) || undefined;
}

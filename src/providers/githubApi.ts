/**
 * GitHub metadata over HTTPS, for machines without the `gh` CLI.
 *
 * The same one request per poll the CLI path makes, against the same GraphQL endpoint,
 * with a token GitRay never stores, never writes to disk, and never logs: it is borrowed
 * from the editor's own GitHub session at the moment of the call and dropped again. This
 * module knows nothing about where the token comes from — that is the caller's business
 * through `TokenSource`, which is also what keeps this file testable without an editor.
 *
 * Metadata only, exactly as before. Every byte of file content still comes from local git.
 */

import { MAX_TRACKED_PULL_REQUESTS, type PullRequest } from '../core/types.js';
import {
  OVERFETCH,
  toPullRequests,
  type RawFile,
  type RawPullRequest
} from './pullRequestFields.js';
import type { RemoteRepository } from './remote.js';

/** Where a token comes from, so this module does not have to care. */
export interface TokenSource {
  /**
   * A GitHub token, or undefined when the user has no session.
   *
   * `interactive` decides whether the user may be asked to sign in. Polling must never
   * ask — a dialog that appears on a timer is worse than the missing feature.
   */
  getToken(options: { interactive: boolean }): Promise<string | undefined>;
}

/** Why a request failed, in the terms the UI reasons about. */
export type ApiFailure = 'signed-out' | 'offline' | 'no-repo';

export class GitHubApiError extends Error {
  constructor(
    readonly kind: ApiFailure,
    message: string
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const ENDPOINT = 'https://api.github.com/graphql';
const TIMEOUT_MS = 45_000;

/** Files per pull request. Beyond this the pull request falls back to file-level counts. */
const FILE_LIMIT = 100;

const PROBE_QUERY = `
query GitRayProbe($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) { nameWithOwner }
}`;

/**
 * The same fields `gh pr list --json` asks for, because gh asks GraphQL for them too.
 * `orderBy` is the one thing gh cannot do: sorting server-side means the pull requests
 * that come back are the ones somebody touched recently.
 */
const LIST_QUERY = `
query GitRayPullRequests($owner: String!, $name: String!, $limit: Int!, $files: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      first: $limit
      states: OPEN
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        number
        title
        author { login }
        headRefName
        headRefOid
        baseRefName
        isDraft
        updatedAt
        url
        additions
        deletions
        files(first: $files) {
          nodes { path additions deletions }
        }
      }
    }
  }
}`;

interface GraphQlError {
  type?: string;
  message?: string;
}

interface GraphQlResponse<T> {
  data?: T | null;
  errors?: GraphQlError[];
}

interface ProbeData {
  viewer?: { login?: string } | null;
  repository?: { nameWithOwner?: string } | null;
}

interface ListData {
  repository?: {
    pullRequests?: { nodes?: (GraphQlPullRequest | null)[] | null } | null;
  } | null;
}

type GraphQlPullRequest = Omit<RawPullRequest, 'files'> & {
  files?: { nodes?: (RawFile | null)[] | null } | null;
};

export class GitHubApi {
  constructor(
    private readonly repo: RemoteRepository,
    private readonly tokens: TokenSource,
    /** Injectable so tests can answer without a network, and Node's global otherwise. */
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)
  ) {}

  /** Who we are and which repository we are looking at, in one request. */
  async probe(): Promise<{ login: string; nameWithOwner: string }> {
    const data = await this.query<ProbeData>(PROBE_QUERY, {
      owner: this.repo.owner,
      name: this.repo.name
    });

    const login = data.viewer?.login;
    if (!login) {
      throw new GitHubApiError(
        'signed-out',
        'GitHub did not say who this session belongs to. Signing in again should fix it.'
      );
    }

    const nameWithOwner = data.repository?.nameWithOwner;
    if (!nameWithOwner) {
      throw new GitHubApiError(
        'no-repo',
        `${this.repo.nameWithOwner} is not visible to this account.`
      );
    }

    return { login, nameWithOwner };
  }

  async listPullRequests(limit: number, includeDrafts: boolean): Promise<PullRequest[]> {
    const data = await this.query<ListData>(LIST_QUERY, {
      owner: this.repo.owner,
      name: this.repo.name,
      // Both transports read the same single page, so both answer with the same pull
      // requests; `gitray.maxPullRequests` is clamped to that page in readConfig.
      limit: Math.min(Math.max(limit, OVERFETCH), MAX_TRACKED_PULL_REQUESTS),
      files: FILE_LIMIT
    });

    const nodes = data.repository?.pullRequests?.nodes ?? [];
    const raw = nodes.filter((node): node is GraphQlPullRequest => node !== null).map(flatten);
    return toPullRequests(raw, limit, includeDrafts);
  }

  /**
   * One GraphQL request, with every failure mode named.
   *
   * GitHub reports missing repositories and expired tokens through three different
   * channels — the transport, the HTTP status, and a 200 response carrying an `errors`
   * array — and telling them apart here is what lets the sidebar offer the right fix
   * instead of a stack trace.
   */
  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await this.tokens.getToken({ interactive: false });
    if (!token) {
      throw new GitHubApiError('signed-out', 'Sign in to GitHub to see open pull requests.');
    }

    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'GitRay'
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (error) {
      throw new GitHubApiError('offline', describeNetworkFailure(error));
    }

    if (response.status === 401) {
      throw new GitHubApiError(
        'signed-out',
        'GitHub rejected this session. Signing in again should fix it.'
      );
    }
    if (response.status === 403 || response.status === 429) {
      throw new GitHubApiError('offline', describeThrottling(response));
    }
    if (!response.ok) {
      throw new GitHubApiError('offline', `GitHub returned HTTP ${response.status}.`);
    }

    let payload: GraphQlResponse<T>;
    try {
      payload = (await response.json()) as GraphQlResponse<T>;
    } catch {
      throw new GitHubApiError('offline', 'GitHub returned a response GitRay could not read.');
    }

    if (payload.errors?.length) throw fromGraphQlErrors(payload.errors, this.repo);
    if (!payload.data) {
      throw new GitHubApiError('offline', 'GitHub returned an empty response.');
    }
    return payload.data;
  }
}

/** GraphQL nests its lists one level deeper than gh's JSON does. */
function flatten(node: GraphQlPullRequest): RawPullRequest {
  const { files, ...rest } = node;
  const nodes = files?.nodes ?? [];
  return { ...rest, files: nodes.filter((file): file is RawFile => file !== null) };
}

/**
 * A 200 response can still be a failure, and the `type` says which.
 *
 * NOT_FOUND covers both a repository that does not exist and one this account cannot see —
 * GitHub deliberately does not distinguish, so neither can the message. FORBIDDEN is the
 * narrower case where the account can see the repository but the token's scopes fall short,
 * which sounds like the same thing to a user and needs the same answer: sign in with access.
 */
function fromGraphQlErrors(errors: GraphQlError[], repo: RemoteRepository): GitHubApiError {
  const first = errors[0];
  const detail = first?.message?.trim();

  if (first?.type === 'NOT_FOUND') {
    return new GitHubApiError(
      'no-repo',
      `${repo.nameWithOwner} is not visible to this account. If it is private, sign in with an account that can see it.`
    );
  }
  if (first?.type === 'FORBIDDEN') {
    return new GitHubApiError('no-repo', detail || `Access to ${repo.nameWithOwner} was refused.`);
  }
  return new GitHubApiError('offline', detail || 'GitHub rejected the request.');
}

function describeThrottling(response: Response): string {
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    return 'GitHub’s rate limit is exhausted. GitRay will pick up again once it resets.';
  }
  return `GitHub refused the request (HTTP ${response.status}).`;
}

/**
 * `fetch` reports DNS failures, refused connections, and timeouts all as a bare TypeError,
 * with the useful part on `cause`. Digging it out is the difference between "GitHub is
 * unreachable — fetch failed" and a message that names the proxy.
 */
function describeNetworkFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'the request to GitHub timed out.';
  }
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (cause instanceof Error && cause.message) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

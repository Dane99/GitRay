/**
 * Muting, from both ends.
 *
 * The gap this closes: mute was half a feature. `gitray.mutedAuthors` was read by the sync
 * engine but no command ever wrote it, so muting a person meant hand-editing settings.json;
 * and muting a pull request was one click with no way back except "Unmute All", because
 * nothing anywhere showed you what was muted. A filter you cannot see is a filter you
 * cannot undo.
 *
 * So these tests pin down the whole loop: the engine keeps what it hides, the tree shows
 * it, and the commands write exactly the setting they claim to — including from a context
 * menu, which hands a command the tree node rather than the tidy argument object the hover
 * card passes.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { makeVscodeStub, type VscodeStub } from './vscodeStub.js';
import type { PullRequest } from '../../src/core/types.js';

type ModuleLoader = { _load(request: string, parent: unknown, isMain: boolean): unknown };

let stub: VscodeStub;
let Store: typeof import('../../src/model/store.js').Store;
let SyncEngine: typeof import('../../src/sync/engine.js').SyncEngine;
let PulseTreeProvider: typeof import('../../src/ui/tree.js').PulseTreeProvider;
let registerCommands: typeof import('../../src/ui/commands.js').registerCommands;
let readConfig: typeof import('../../src/core/config.js').readConfig;

const ROOT = '/repo';

before(async () => {
  stub = makeVscodeStub(ROOT);

  const loader = Module as unknown as ModuleLoader;
  const original = loader._load;
  loader._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub.api;
    return original.call(this, request, parent, isMain);
  };

  ({ Store } = await import('../../src/model/store.js'));
  ({ SyncEngine } = await import('../../src/sync/engine.js'));
  ({ PulseTreeProvider } = await import('../../src/ui/tree.js'));
  ({ registerCommands } = await import('../../src/ui/commands.js'));
  ({ readConfig } = await import('../../src/core/config.js'));
});

beforeEach(() => {
  for (const key of Object.keys(stub.settings)) delete stub.settings[key];
});

function pullRequest(number: number, author: string, title: string): PullRequest {
  return {
    number,
    title,
    author,
    headRefName: `feat/${number}`,
    headRefOid: `oid${number}`,
    baseRefName: 'main',
    isDraft: false,
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    url: `https://github.com/acme/app/pull/${number}`,
    additions: 3,
    deletions: 1,
    files: [{ path: `src/file${number}.ts`, additions: 3, deletions: 1 }]
  };
}

/** Just enough Repository for the tree and the commands; nothing here touches git. */
function fakeRepository() {
  const Uri = stub.api.Uri as { file(path: string): unknown };
  return {
    root: ROOT,
    folder: { uri: Uri.file(ROOT), name: 'repo', index: 0 },
    uriFor: (path: string) => Uri.file(`${ROOT}/${path}`),
    relativePath: () => undefined,
    git: { headSha: async () => 'head1' },
    github: { pullRequestUrl: async () => undefined }
  } as never;
}

const fakeScanner = {
  onDidChange: () => ({ dispose: () => {} }),
  hotFiles: () => [],
  collisionCount: () => 0
} as never;

const noopEvent = () => ({ dispose: () => {} });

/**
 * A single-repository workspace, which is what every scenario below is about.
 *
 * The multi-root behaviour these fakes stand in for has its own test; here they exist so
 * mute can be exercised without a real repository behind it.
 */
function fakeWorkspace(session: unknown) {
  return {
    ready: true,
    size: 1,
    all: () => [session],
    only: () => session,
    active: () => session,
    sessionFor: () => session,
    sessionAt: (root: string | undefined) => (root === ROOT ? session : undefined),
    collisionCount: () => 0,
    onDidChange: noopEvent
  } as never;
}

/** Assemble the pieces a mute scenario needs, wired the way the extension wires them. */
function harness() {
  const store = new Store();
  const repository = fakeRepository();
  const requests: string[] = [];

  const session = {
    repository,
    store,
    scanner: fakeScanner,
    analyzer: { mergeBaseFor: async () => undefined },
    engine: {},
    controller: { refreshVisible: () => {}, analysisFor: () => undefined },
    scheduler: {
      request: async (reason: string) => {
        requests.push(reason);
      }
    },
    id: ROOT,
    label: 'repo',
    config: () => readConfig((repository as { folder: { uri: never } }).folder.uri),
    onDidChange: noopEvent
  };

  const workspace = fakeWorkspace(session);
  const tree = new PulseTreeProvider(workspace);
  const disposables = registerCommands({
    extensionUri: (stub.api.Uri as { file(p: string): never }).file(ROOT),
    workspace
  });

  const run = async (command: string, arg?: unknown): Promise<void> => {
    const handler = stub.registeredCommands.get(command);
    assert.ok(handler, `command "${command}" was never registered`);
    await handler(arg);
  };

  return {
    store,
    tree,
    run,
    requests,
    dispose: () => {
      tree.dispose();
      for (const disposable of disposables) disposable.dispose();
      store.dispose();
    }
  };
}

/** The rows under the Muted header, as VS Code would render them. */
async function mutedRows(harnessed: ReturnType<typeof harness>) {
  const roots = await harnessed.tree.getChildren();
  const header = roots.find((node) => node.kind === 'mutedHeader');
  if (!header) return undefined;

  const children = await harnessed.tree.getChildren(header);
  return {
    header: harnessed.tree.getTreeItem(header),
    items: children.map((child) => harnessed.tree.getTreeItem(child)),
    nodes: children
  };
}

// --- The engine keeps what it hides ----------------------------------------------------

test('muted pull requests are recorded rather than dropped on the floor', async () => {
  const store = new Store();
  const engine = new SyncEngine(fakeRepository(), store, { reset: () => {} } as never);

  stub.settings['gitray.mutedPullRequests'] = [412];
  stub.settings['gitray.mutedAuthors'] = ['NoisyBot'];

  engine.useFixture([
    pullRequest(412, 'ada', 'Rework the parser'),
    pullRequest(413, 'noisybot', 'Bump dependencies'),
    pullRequest(414, 'grace', 'Fix the header lookup')
  ]);
  await engine.sync(readConfig());

  assert.deepEqual(
    store.allPullRequests().map((pr) => pr.number),
    [414],
    'only the unmuted pull request should reach the surfaces'
  );
  assert.equal(
    store.mutedPullRequest(412)?.title,
    'Rework the parser',
    'the muted pull request keeps its title, which is what makes the row reviewable'
  );
  assert.equal(
    store.mutedPullRequestsBy('noisybot').length,
    1,
    'an author mute is matched case-insensitively against the login GitHub reported'
  );
  assert.equal(store.mutedPullRequest(414), undefined, 'nothing visible is also muted');

  store.dispose();
});

// --- The tree shows it -----------------------------------------------------------------

test('nothing muted means no Muted section at all', async () => {
  const h = harness();
  const roots = await h.tree.getChildren();

  assert.equal(
    roots.find((node) => node.kind === 'mutedHeader'),
    undefined,
    'an empty section would be one more row teaching people to ignore this view'
  );
  h.dispose();
});

test('a muted pull request shows its title, its number, and its author', async () => {
  stub.settings['gitray.mutedPullRequests'] = [412];

  const h = harness();
  h.store.setMutedPullRequests([pullRequest(412, 'ada', 'Rework the parser')]);

  const rows = await mutedRows(h);
  assert.ok(rows, 'the Muted section should exist once something is muted');
  assert.equal(rows.header.description, '1 pull request');
  assert.equal(rows.items[0].label, 'Rework the parser');
  assert.equal(rows.items[0].description, '#412 · ada');
  assert.equal(rows.items[0].contextValue, 'gitray.mutedPr');

  h.dispose();
});

test('a muted number GitRay has never seen still gets a row it can be unmuted from', async () => {
  // The common case for a stale entry: the pull request merged months ago, so it is in no
  // list anywhere. Dropping the row would strand the setting permanently.
  stub.settings['gitray.mutedPullRequests'] = [77];

  const h = harness();
  const rows = await mutedRows(h);

  assert.ok(rows);
  assert.equal(rows.items[0].label, '#77');
  assert.equal(rows.items[0].description, 'not in the open list');

  h.dispose();
});

test('a muted author is listed with how much they are hiding', async () => {
  stub.settings['gitray.mutedAuthors'] = ['NoisyBot'];

  const h = harness();
  h.store.setMutedPullRequests([
    pullRequest(413, 'noisybot', 'Bump dependencies'),
    pullRequest(415, 'noisybot', 'Bump dependencies again')
  ]);

  const rows = await mutedRows(h);
  assert.ok(rows);
  assert.equal(rows.header.description, '1 author');
  assert.equal(rows.items[0].label, 'NoisyBot', 'the login is shown as the user wrote it');
  assert.equal(rows.items[0].description, '2 open pull requests');
  assert.equal(rows.items[0].contextValue, 'gitray.mutedAuthor');

  h.dispose();
});

test('a muted author with nothing open says so rather than looking broken', async () => {
  stub.settings['gitray.mutedAuthors'] = ['ada'];

  const h = harness();
  const rows = await mutedRows(h);

  assert.ok(rows);
  assert.equal(rows.items[0].description, 'nothing open right now');

  h.dispose();
});

test('the section reappears when the settings change under it', async () => {
  // Muting while GitHub is unreachable lands no sync, so the store never fires. Without the
  // configuration listener the row would not appear until something else happened to
  // repaint the view.
  const h = harness();
  assert.equal(await mutedRows(h), undefined);

  let refreshed = false;
  h.tree.onDidChangeTreeData(() => {
    refreshed = true;
  });
  await h.run('gitray.muteAuthor', { author: 'ada' });

  assert.ok(refreshed, 'the tree should repaint when gitray.* settings change');
  assert.ok(await mutedRows(h), 'and the muted author should now have a row');

  h.dispose();
});

// --- The commands write what they claim to ---------------------------------------------

test('muting from a context menu acts on the row it was invoked from', async () => {
  // Context menus hand the command the tree node, not the {prNumber} object the hover card
  // passes. Reading only the latter is what used to make a one-click mute open a quick pick
  // asking which pull request you meant.
  const h = harness();
  const pr = pullRequest(412, 'Ada', 'Rework the parser');

  await h.run('gitray.mutePullRequest', { kind: 'pullRequest', pr });
  assert.deepEqual(stub.settings['gitray.mutedPullRequests'], [412]);

  await h.run('gitray.muteAuthor', { kind: 'pullRequest', pr });
  assert.deepEqual(
    stub.settings['gitray.mutedAuthors'],
    ['Ada'],
    'the login is stored as GitHub spelled it'
  );

  h.dispose();
});

test('unmuting one entry leaves the others muted', async () => {
  stub.settings['gitray.mutedPullRequests'] = [412, 413];
  stub.settings['gitray.mutedAuthors'] = ['NoisyBot', 'ada'];

  const h = harness();
  const rows = await mutedRows(h);
  assert.ok(rows);

  // Exactly what an inline button on the row passes.
  const authorRow = rows.nodes.find(
    (node) => node.kind === 'mutedAuthor' && node.author === 'NoisyBot'
  );
  const prRow = rows.nodes.find((node) => node.kind === 'mutedPullRequest' && node.prNumber === 413);

  await h.run('gitray.unmuteAuthor', authorRow);
  await h.run('gitray.unmutePullRequest', prRow);

  assert.deepEqual(stub.settings['gitray.mutedAuthors'], ['ada']);
  assert.deepEqual(stub.settings['gitray.mutedPullRequests'], [412]);

  h.dispose();
});

test('unmuting an author matches whatever casing the setting was written in', async () => {
  stub.settings['gitray.mutedAuthors'] = ['NoisyBot'];

  const h = harness();
  await h.run('gitray.unmuteAuthor', { author: 'noisybot' });

  assert.deepEqual(stub.settings['gitray.mutedAuthors'], []);

  h.dispose();
});

test('unmute all clears both lists and reports how much it restored', async () => {
  stub.settings['gitray.mutedPullRequests'] = [412];
  stub.settings['gitray.mutedAuthors'] = ['NoisyBot'];

  const h = harness();
  await h.run('gitray.unmuteAll');

  assert.deepEqual(stub.settings['gitray.mutedPullRequests'], []);
  assert.deepEqual(stub.settings['gitray.mutedAuthors'], []);
  assert.ok(h.requests.length > 0, 'unmuting must trigger a resync, or nothing comes back');

  h.dispose();
});

test('muting the same pull request twice does not duplicate the entry', async () => {
  stub.settings['gitray.mutedPullRequests'] = [412];

  const h = harness();
  await h.run('gitray.mutePullRequest', { prNumber: 412 });

  assert.deepEqual(stub.settings['gitray.mutedPullRequests'], [412]);

  h.dispose();
});

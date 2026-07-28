/**
 * What the status bar shows, and — the part that fails silently — whether it shows at all.
 *
 * There is one item for the whole window, so with several repositories attached it has to
 * decide what a single line says about all of them. Two of those decisions are easy to get
 * wrong in a way nothing else catches: hiding is indistinguishable from having nothing to
 * report, and a total that quietly covered one folder of several would be the most
 * misleading number on screen.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { makeVscodeStub, type VscodeStub } from './vscodeStub.js';
import type { PullRequest, StatusInfo } from '../../src/core/types.js';

type ModuleLoader = { _load(request: string, parent: unknown, isMain: boolean): unknown };

let stub: VscodeStub;
let StatusBar: typeof import('../../src/ui/statusBar.js').StatusBar;

before(async () => {
  stub = makeVscodeStub('/repo/alpha', '/repo/beta');

  const loader = Module as unknown as ModuleLoader;
  const original = loader._load;
  loader._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub.api;
    return original.call(this, request, parent, isMain);
  };

  ({ StatusBar } = await import('../../src/ui/statusBar.js'));
});

beforeEach(() => {
  stub.statusBarItems.length = 0;
});

interface FakeSession {
  label: string;
  status: StatusInfo;
  pullRequests: PullRequest[];
  behind: number;
  collisions: number;
}

function session(label: string, overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    label,
    status: { state: 'ready', pullRequestCount: 0, lastSync: Date.now() },
    pullRequests: [],
    behind: 0,
    collisions: 0,
    ...overrides
  };
}

function pullRequest(number: number, author: string): PullRequest {
  return {
    number,
    title: `Change ${number}`,
    author,
    headRefName: `feat/${number}`,
    headRefOid: `oid${number}`,
    baseRefName: 'main',
    isDraft: false,
    updatedAt: new Date().toISOString(),
    url: `https://github.com/acme/app/pull/${number}`,
    additions: 1,
    deletions: 1,
    files: [{ path: `src/file${number}.ts`, additions: 1, deletions: 1 }]
  };
}

/** Render one status bar over these sessions and hand back what it produced. */
function render(sessions: FakeSession[]) {
  const adapted = sessions.map((fake) => ({
    label: fake.label,
    store: {
      currentStatus: () => fake.status,
      allPullRequests: () => fake.pullRequests,
      // `behindMainline` counts commits and treats tip === base as "not behind", so the
      // commit list is what has to be the right length here.
      mainline: () =>
        fake.behind === 0
          ? undefined
          : {
              branch: 'main',
              tip: 'tip',
              base: 'base',
              commits: Array.from({ length: fake.behind }, (_, index) => ({
                sha: `sha${index}`,
                subject: 'landed',
                author: 'someone',
                date: new Date().toISOString()
              }))
            }
    },
    scanner: { collisionCount: () => fake.collisions }
  }));

  const workspace = {
    size: adapted.length,
    all: () => adapted,
    collisionCount: () => sessions.reduce((total, one) => total + one.collisions, 0),
    onDidChange: () => ({ dispose: () => {} })
  } as never;

  const bar = new StatusBar(workspace);
  const item = stub.statusBarItems[stub.statusBarItems.length - 1];
  bar.dispose();
  return item;
}

test('counts are the whole window, not one repository', () => {
  const item = render([
    session('alpha', { pullRequests: [pullRequest(1, 'ada')], collisions: 2 }),
    session('beta', { pullRequests: [pullRequest(2, 'grace'), pullRequest(3, 'ada')] })
  ]);

  assert.ok(item.visible);
  assert.match(item.text, /\b3\b/, 'three open pull requests across two repositories');
  assert.match(item.text, /⟂ 2/, 'and the collisions from whichever repository has them');
});

test('the tooltip breaks the total down per repository', () => {
  const item = render([
    session('alpha', { pullRequests: [pullRequest(1, 'ada')] }),
    session('beta', { collisions: 3 })
  ]);

  const tooltip = String((item.tooltipHistory.at(-1) as { value?: string })?.value ?? '');
  assert.match(tooltip, /alpha/, 'a total nobody can trace back is not worth showing');
  assert.match(tooltip, /beta/);
});

test('nothing to report anywhere means no item at all', () => {
  const item = render([session('alpha'), session('beta')]);
  assert.equal(item.visible, false, 'hiding beats showing a row of zeroes');
});

/**
 * The regression this exists for.
 *
 * With one repository degraded and the other merely quiet, the counts are all zero — so a
 * hide decision made on the counts alone takes the only report of the breakage off screen.
 * A single degraded repository has always shown something, and nothing about adding a
 * healthy folder next to it should change that.
 */
test('a degraded repository keeps the item visible even when the rest is quiet', () => {
  const item = render([
    session('alpha', {
      status: { state: 'degraded', pullRequestCount: 0, reason: 'signed-out', message: 'Sign in to GitHub' }
    }),
    session('beta')
  ]);

  assert.ok(item.visible, 'the breakage would otherwise be reported nowhere');
  assert.match(item.text, /GitRay/, 'and a bare icon with no number beside it reads as nothing');

  const tooltip = String((item.tooltipHistory.at(-1) as { value?: string })?.value ?? '');
  assert.match(tooltip, /Sign in to GitHub/, 'the reason has to survive to the tooltip');
});

test('every repository degraded says so without pretending to have counts', () => {
  const item = render([
    session('alpha', {
      status: { state: 'degraded', pullRequestCount: 0, message: 'No GitHub remote' }
    }),
    session('beta', {
      status: { state: 'error', pullRequestCount: 0, message: 'git exploded' }
    })
  ]);

  assert.ok(item.visible);
  const tooltip = String((item.tooltipHistory.at(-1) as { value?: string })?.value ?? '');
  assert.match(tooltip, /No GitHub remote/);
  assert.match(tooltip, /git exploded/, 'both reasons, since either might be the one you can fix');
});

test('with nothing attached there is no item', () => {
  const item = render([]);
  assert.equal(item.visible, false);
});

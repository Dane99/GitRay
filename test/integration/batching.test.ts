/**
 * The batched git reads, against real git.
 *
 * GitRay used to ask git one file at a time: a diff per file per pull request, a log per
 * file for the mainline, a `git show` per base copy. The batched forms replace hundreds of
 * process spawns per scan with a handful, and each of them has to answer exactly what the
 * one-file form it replaces would have — these tests hold them to that.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'node:module';

import { makeVscodeStub } from './vscodeStub.js';
import type { PullRequest } from '../../src/core/types.js';

let Git: typeof import('../../src/providers/git.js').Git;
let prRef: typeof import('../../src/providers/git.js').prRef;
let Store: typeof import('../../src/model/store.js').Store;
let Analyzer: typeof import('../../src/model/analyzer.js').Analyzer;
let CollisionScanner: typeof import('../../src/sync/scanner.js').CollisionScanner;
let readConfig: typeof import('../../src/core/config.js').readConfig;
let stub: ReturnType<typeof makeVscodeStub>;

let root: string;
let base: string;
let tip: string;
let head: string;

/** A path with glob characters in it, the shape Next.js routes come in. */
const ROUTE = 'app/[id].tsx';
const FILES = ['src/a.ts', 'src/b.ts', ROUTE];

function lines(tag: string): string[] {
  return Array.from({ length: 20 }, (_, i) => `const ${tag}${i} = ${i};`);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function write(path: string, content: string[]): void {
  const full = join(root, ...path.split('/'));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content.join('\n') + '\n', 'utf8');
}

function withLine(content: string[], index: number, text: string): string[] {
  const next = content.slice();
  next[index] = text;
  return next;
}

before(async () => {
  stub = makeVscodeStub();
  const loader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const original = loader._load;
  loader._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub.api;
    return original.call(this, request, parent, isMain);
  };

  ({ Git, prRef } = await import('../../src/providers/git.js'));
  ({ Store } = await import('../../src/model/store.js'));
  ({ Analyzer } = await import('../../src/model/analyzer.js'));
  ({ CollisionScanner } = await import('../../src/sync/scanner.js'));
  ({ readConfig } = await import('../../src/core/config.js'));

  root = mkdtempSync(join(tmpdir(), 'gitray-batch-'));
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'GitRay Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');

  write('src/a.ts', lines('a'));
  write('src/b.ts', lines('b'));
  write(ROUTE, lines('r'));
  git('add', '.');
  git('commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD').trim();

  // A pull request touching all three files, parked where a fetch would put it.
  git('checkout', '-q', '-b', 'theirs');
  write('src/a.ts', withLine(lines('a'), 3, 'const a3 = THEIRS;'));
  write('src/b.ts', withLine(lines('b'), 7, 'const b7 = THEIRS;'));
  write(ROUTE, withLine(lines('r'), 1, 'const r1 = THEIRS;'));
  git('commit', '-qam', 'their change');
  git('update-ref', prRef(1), 'HEAD');

  // The mainline moves on: one plain commit, and one merge of a side branch, which is the
  // shape a per-path `--first-parent` log and the batched log most easily disagree on.
  git('checkout', '-q', 'main');
  write('src/a.ts', withLine(lines('a'), 15, 'const a15 = MERGED;'));
  git('commit', '-qam', 'Tune a (#10)');
  git('checkout', '-q', '-b', 'side', base);
  write('src/b.ts', withLine(lines('b'), 18, 'const b18 = SIDE;'));
  git('commit', '-qam', 'side work');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'Merge pull request #11 from side', 'side');
  tip = git('rev-parse', 'HEAD').trim();

  // You are still where you left the mainline.
  git('checkout', '-q', '-b', 'yours', base);
  head = git('rev-parse', 'HEAD').trim();
});

after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows may still hold a handle; the OS cleans the temp directory up.
  }
});

function pullRequest(): PullRequest {
  return {
    number: 1,
    title: 'Their change',
    author: 'ada',
    headRefName: 'theirs',
    headRefOid: git('rev-parse', prRef(1)).trim(),
    baseRefName: 'main',
    isDraft: false,
    updatedAt: new Date().toISOString(),
    url: 'https://github.com/acme/app/pull/1',
    additions: 3,
    deletions: 3,
    files: FILES.map((path) => ({ path, additions: 1, deletions: 1 }))
  };
}

test('the batched blob reader answers exactly what git show does', async () => {
  const api = new Git(root);
  try {
    for (const rev of [base, tip]) {
      for (const path of FILES) {
        assert.equal(await api.readFile(rev, path), await api.showFile(rev, path), `${rev}:${path}`);
      }
    }
    assert.equal(await api.readFile(base, 'src/missing.ts'), undefined, 'a missing file');
    assert.equal(await api.readFile(base, 'src'), undefined, 'a directory is not a file');
  } finally {
    api.dispose();
  }
});

test('many concurrent reads come back in the right order', async () => {
  const api = new Git(root);
  try {
    const requests = Array.from({ length: 30 }, (_, i) => FILES[i % FILES.length]);
    const answers = await Promise.all(requests.map((path) => api.readFile(tip, path)));
    for (let i = 0; i < requests.length; i++) {
      assert.equal(answers[i], await api.showFile(tip, requests[i]));
    }
  } finally {
    api.dispose();
  }
});

test('one ref listing reports every head GitRay has parked', async () => {
  const refs = await new Git(root).refOids('refs/gitray');
  assert.equal(refs.get(prRef(1)), git('rev-parse', prRef(1)).trim());
  assert.equal(refs.size, 1);
});

test('the whole-range log attributes commits the way a per-file log does', async () => {
  const api = new Git(root);
  const byPath = await api.commitsByPath(base, tip);

  for (const path of FILES) {
    const perFile = await api.commitsIn(base, tip, path);
    assert.deepEqual(
      (byPath.get(path) ?? []).map((commit) => commit.sha),
      perFile.map((commit) => commit.sha),
      path
    );
  }
  assert.equal(byPath.get('src/b.ts')?.[0]?.prNumber, 11, 'the merge commit is credited');
});

test('analyzing one file reads the pull request once for all of its files', async () => {
  const store = new Store();
  const api = new Git(root);
  const analyzer = new Analyzer(api, store, {
    name: async () => undefined,
    choose: async () => ({ kind: 'none' })
  } as never);

  const pr = pullRequest();
  store.setPullRequests([pr]);
  const text = lines('a').join('\n') + '\n';
  const analysis = await analyzer.analyze('src/a.ts', text, 1, [pr], {
    proximityLines: 3,
    maxRegionsPerFile: 400
  });
  assert.deepEqual(
    analysis.regions.map((region) => region.baseRange),
    [{ start: 3, end: 4 }]
  );

  // Never asked about, and already answered — including the file whose name is a glob.
  assert.deepEqual(
    store.cachedRegions('src/b.ts', 1, pr.headRefOid)?.map((region) => region.baseRange),
    [{ start: 7, end: 8 }]
  );
  assert.deepEqual(
    store.cachedRegions(ROUTE, 1, pr.headRefOid)?.map((region) => region.baseRange),
    [{ start: 1, end: 2 }]
  );

  store.dispose();
  api.dispose();
});

test('mainline drift read for the whole range matches what landed per file', async () => {
  const store = new Store();
  const api = new Git(root);
  const analyzer = new Analyzer(api, store, {
    name: async () => undefined,
    choose: async () => ({ kind: 'none' })
  } as never);
  const mainline = { branch: 'main', base, tip, commits: [] };

  // Your edits sit on the lines the mainline moved, so its drift is reported rather than
  // dropped as ambient.
  const yoursA = withLine(lines('a'), 15, 'const a15 = YOURS;').join('\n') + '\n';
  const yoursB = withLine(lines('b'), 18, 'const b18 = YOURS;').join('\n') + '\n';

  const a = await analyzer.analyze('src/a.ts', yoursA, 1, [], {
    proximityLines: 3,
    maxRegionsPerFile: 400,
    mainline
  });
  const b = await analyzer.analyze('src/b.ts', yoursB, 1, [], {
    proximityLines: 3,
    maxRegionsPerFile: 400,
    mainline
  });

  assert.deepEqual(a.regions.map((region) => [region.baseRange.start, region.severity]), [
    [15, 'collision']
  ]);
  assert.deepEqual(b.regions.map((region) => [region.baseRange.start, region.severity]), [
    [18, 'collision']
  ]);
  assert.equal(b.regions[0]?.origin.kind === 'mainline' && b.regions[0].origin.commits.length, 1);
  assert.equal(head, base, 'the fixture keeps you where you left the mainline');

  store.dispose();
  api.dispose();
});

test('a file several megabytes long comes back whole through the blob reader', async () => {
  // Built with plumbing, so the working tree the other tests read is left alone. Large
  // enough to arrive in many chunks, which is the case the reader's buffering exists for.
  const content = Array.from({ length: 120_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: content, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['mktree'], { cwd: root, input: `100644 blob ${blob}\tbig.txt\n`, encoding: 'utf8' }).trim();
  const commit = execFileSync('git', ['commit-tree', tree, '-m', 'big'], { cwd: root, encoding: 'utf8' }).trim();

  const api = new Git(root);
  try {
    const [first, second] = await Promise.all([api.readFile(commit, 'big.txt'), api.readFile(base, 'src/a.ts')]);
    assert.equal(first?.length, content.length);
    assert.equal(first, content);
    assert.equal(second, await api.showFile(base, 'src/a.ts'), 'and the answer after it is not misaligned');
  } finally {
    api.dispose();
  }
});

/** An analyzer whose `git merge-base` calls are counted. */
function countingAnalyzer() {
  const store = new Store();
  const api = new Git(root);
  let mergeBases = 0;
  const mergeBase = api.mergeBase.bind(api);
  api.mergeBase = async (...args: Parameters<typeof api.mergeBase>) => {
    mergeBases++;
    return mergeBase(...args);
  };
  const analyzer = new Analyzer(api, store, {
    name: async () => undefined,
    choose: async () => ({ kind: 'none' })
  } as never);
  return { store, api, analyzer, mergeBases: () => mergeBases };
}

test('a commit keeps every merge base except those of pull requests containing it', async () => {
  const h = countingAnalyzer();
  const options = { proximityLines: 3, maxRegionsPerFile: 400 };
  const text = lines('a').join('\n') + '\n';

  // A commit on top of where you are, made off to the side, and a second pull request
  // built on top of it — the one case where gaining a commit moves a merge base.
  const tree = git('rev-parse', `${head}^{tree}`).trim();
  const gained = execFileSync('git', ['commit-tree', tree, '-p', head, '-m', 'your commit'], { cwd: root, encoding: 'utf8' }).trim();
  const onTop = execFileSync('git', ['commit-tree', tree, '-p', gained, '-m', 'theirs, on top of yours'], { cwd: root, encoding: 'utf8' }).trim();
  git('update-ref', prRef(2), onTop);

  const first = pullRequest();
  const second = { ...pullRequest(), number: 2, headRefOid: onTop };
  h.store.setPullRequests([first, second]);

  await h.analyzer.analyze('src/a.ts', text, 1, [first, second], options);
  assert.equal(h.mergeBases(), 2, 'one merge base per pull request to start with');

  await h.analyzer.headMoved(head, gained);
  await h.analyzer.analyze('src/a.ts', text, 1, [first, second], options);
  assert.equal(h.mergeBases(), 3, 'only the pull request containing the new commit is asked again');

  // Anything that is not a step forward starts over.
  await h.analyzer.headMoved(gained, base === head ? tip : base);
  await h.analyzer.analyze('src/a.ts', text, 1, [first, second], options);
  assert.equal(h.mergeBases(), 5, 'a jump recomputes everything');

  git('update-ref', '-d', prRef(2));
  h.store.dispose();
  h.api.dispose();
});

test('a scan counts only what you changed, not what landed upstream since a pull request branched', async () => {
  // You are level with the mainline and have edited one file. The pull request branched
  // from the old base, so everything the mainline changed since then separates its merge
  // base from your working tree — none of which is your work.
  git('checkout', '-q', '-B', 'level', tip);
  git('update-ref', 'refs/gitray/mainline/main', tip);
  write('src/a.ts', withLine(git('show', `${tip}:src/a.ts`).trimEnd().split('\n'), 3, 'const a3 = YOURS;'));

  const store = new Store();
  const api = new Git(root);
  const analyzer = new Analyzer(api, store, {
    name: async () => undefined,
    choose: async () => ({ kind: 'none' })
  } as never);
  const Uri = stub.api.Uri as { file(path: string): unknown };
  const repository = {
    git: api,
    uriFor: (path: string) => Uri.file(join(root, ...path.split('/')))
  };
  const scanner = new CollisionScanner(repository as never, store, analyzer);

  const pr = pullRequest();
  store.setPullRequests([pr]);
  await scanner.scan(readConfig());

  assert.ok(scanner.analysisFor('src/a.ts'), 'the file you edited is scanned');
  assert.equal(
    scanner.analysisFor('src/b.ts'),
    undefined,
    'a file only the mainline changed is not yours, and is not scanned'
  );

  git('checkout', '-q', '-f', 'yours');
  git('update-ref', '-d', 'refs/gitray/mainline/main');
  scanner.dispose();
  store.dispose();
  api.dispose();
});

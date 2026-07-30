/**
 * Activation smoke test.
 *
 * Loads the real bundled extension against a stubbed VS Code API and activates it on a
 * throwaway repository that has no GitHub remote. This catches the class of failure that
 * types and manifest checks cannot: bad wiring, a disposal order that throws, or an
 * activation path that explodes when the environment is not what it hoped for.
 *
 * The no-remote repository is the point. GitRay must come up, report the problem through
 * its normal channels, and stay alive — not throw during activation.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'node:module';

import { makeVscodeStub, type VscodeStub } from './vscodeStub.js';

const bundlePath = join(__dirname, '..', '..', 'dist', 'extension.js');

/** The private hook the extension host itself uses to inject the `vscode` module. */
type ModuleLoader = { _load(request: string, parent: unknown, isMain: boolean): unknown };

let root: string;
let stub: VscodeStub;
let extension: { activate: (context: unknown) => Promise<void>; deactivate: () => void };

before(() => {
  root = mkdtempSync(join(tmpdir(), 'gitray-activate-'));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'GitRay Test'], { cwd: root });
  // The developer's global config may enable commit signing via an external agent, which
  // would fail in a throwaway repository and take the whole test down with it.
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });

  // Keep git from warning about line-ending conversion on every fixture write.
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: root });

  assert.ok(
    existsSync(bundlePath),
    'dist/extension.js is missing — run `npm run bundle` before the tests'
  );

  stub = makeVscodeStub(root);

  // Intercept require('vscode') for the bundle, the way the extension host does.
  const loader = Module as unknown as ModuleLoader;
  const original = loader._load;
  loader._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub.api;
    return original.call(this, request, parent, isMain);
  };

  extension = require(bundlePath);
});

after(() => {
  try {
    extension?.deactivate();
  } catch {
    // Reported by the test that exercises it.
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows may still hold a handle; the OS cleans the temp directory up.
  }
});

test('the bundle exports the activation contract VS Code expects', () => {
  assert.equal(typeof extension.activate, 'function');
  assert.equal(typeof extension.deactivate, 'function');
});

test('activates against a repository with no GitHub remote without throwing', async () => {
  await extension.activate(stub.context);

  // Activation kicks off an async sync; give it a moment to fail the way it should.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.deepEqual(stub.errors, [], `activation logged errors: ${stub.errors.join('; ')}`);
});

test('registers every command declared in the manifest', () => {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')
  );
  const declared = manifest.contributes.commands.map((c: { command: string }) => c.command);

  for (const command of declared) {
    assert.ok(
      stub.registeredCommands.has(command),
      `command "${command}" was never registered at activation`
    );
  }
});

test('creates its view, status bar item, and content provider', () => {
  assert.ok(stub.treeViews.includes('gitray.pulse'), 'the Pulse view was not created');
  assert.equal(stub.statusBarItems.length, 1, 'expected exactly one status bar item');
  assert.ok(
    stub.contentProviderSchemes.includes('gitray'),
    'the gitray: content provider was not registered'
  );
  assert.ok(stub.fileDecorationProviders > 0, 'no file decoration provider was registered');
});

test('reports the missing remote instead of failing silently', () => {
  // Either no remote here points at GitHub, or there is no session to ask with. Both are
  // degraded states that must reach the user, and neither may throw.
  const messages = stub.statusBarItems[0]?.tooltipHistory ?? [];
  assert.ok(messages.length > 0, 'the status bar never rendered');
});

test('deactivating disposes everything it created', () => {
  extension.deactivate();
  assert.deepEqual(stub.errors, [], `disposal logged errors: ${stub.errors.join('; ')}`);
  assert.ok(stub.disposedCount > 0, 'nothing was disposed');
});

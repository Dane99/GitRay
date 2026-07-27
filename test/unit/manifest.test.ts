/**
 * Manifest consistency.
 *
 * Contribution points fail silently at runtime: a menu entry naming a command that does
 * not exist simply never appears, and a `ThemeColor` for an id that was never contributed
 * renders as nothing. Neither throws, so neither shows up in any other test. These checks
 * cross-reference package.json against the source that depends on it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Every .ts file under src/, read once. */
const sources = (function collect(dir: string): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return collect(full);
    if (!entry.name.endsWith('.ts')) return [];
    return [{ path: full, text: readFileSync(full, 'utf8') }];
  });
})(join(root, 'src'));

const allSource = sources.map((file) => file.text).join('\n');

const declaredCommands = new Set<string>(
  manifest.contributes.commands.map((command: { command: string }) => command.command)
);

test('every menu entry names a declared command', () => {
  const menus = manifest.contributes.menus as Record<string, { command?: string }[]>;
  for (const [menu, entries] of Object.entries(menus)) {
    for (const entry of entries) {
      if (!entry.command) continue;
      assert.ok(
        declaredCommands.has(entry.command),
        `menu "${menu}" references undeclared command "${entry.command}"`
      );
    }
  }
});

test('every keybinding names a declared command', () => {
  for (const binding of manifest.contributes.keybindings as { command: string }[]) {
    assert.ok(
      declaredCommands.has(binding.command),
      `keybinding references undeclared command "${binding.command}"`
    );
  }
});

test('every declared command is registered in the source', () => {
  for (const command of declaredCommands) {
    assert.ok(
      allSource.includes(`'${command}'`),
      `command "${command}" is declared in package.json but never registered`
    );
  }
});

test('every command registered in the source is declared', () => {
  const registered = [...allSource.matchAll(/registerCommand\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(registered.length > 0, 'expected to find registered commands');

  for (const command of registered) {
    assert.ok(
      declaredCommands.has(command),
      `command "${command}" is registered but missing from package.json`
    );
  }
});

test('every theme color used in the source is contributed', () => {
  const declared = new Set<string>(
    manifest.contributes.colors.map((color: { id: string }) => color.id)
  );

  // Only GitRay's own ids need contributing; the built-in ones VS Code already defines.
  const used = new Set(
    [...allSource.matchAll(/ThemeColor\(\s*'(gitray\.[^']+)'/g)].map((m) => m[1])
  );

  for (const id of used) {
    assert.ok(declared.has(id), `ThemeColor("${id}") is used but never contributed`);
  }
});

test('the eight collaborator hues are all contributed', () => {
  const declared = new Set<string>(
    manifest.contributes.colors.map((color: { id: string }) => color.id)
  );
  for (let slot = 1; slot <= 8; slot++) {
    assert.ok(declared.has(`gitray.collaborator${slot}`), `missing hue ${slot}`);
  }
});

test('every contributed color defines all four theme variants', () => {
  for (const color of manifest.contributes.colors as {
    id: string;
    defaults: Record<string, string>;
  }[]) {
    for (const variant of ['dark', 'light', 'highContrast', 'highContrastLight']) {
      assert.ok(
        typeof color.defaults[variant] === 'string',
        `color "${color.id}" has no ${variant} default`
      );
    }
  }
});

test('every setting read by config.ts is declared', () => {
  const declared = new Set(Object.keys(manifest.contributes.configuration.properties));
  const configSource = sources.find((file) => file.path.endsWith('config.ts'));
  assert.ok(configSource, 'expected src/core/config.ts');

  const read = [...configSource.text.matchAll(/\bget<[^>]+>\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(read.length > 0, 'expected config.ts to read settings');

  for (const key of read) {
    assert.ok(
      declared.has(`gitray.${key}`),
      `config.ts reads "gitray.${key}" but package.json does not declare it`
    );
  }
});

test('every declared setting is actually read', () => {
  const configSource = sources.find((file) => file.path.endsWith('config.ts'));
  assert.ok(configSource);

  for (const key of Object.keys(manifest.contributes.configuration.properties)) {
    const shortKey = key.replace(/^gitray\./, '');
    assert.ok(
      configSource.text.includes(`'${shortKey}'`),
      `setting "${key}" is declared but never read`
    );
  }
});

test('scalar setting defaults agree between package.json and config.ts', () => {
  // Two copies of every default exist: the manifest's, which the editor hands back from
  // `get`, and config.ts's fallback for when the key is absent. Nothing forces them to
  // agree, and a drifted pair changes behaviour without failing anything — the manifest
  // wins in a real host while the fallback wins in tests, so the disagreement is invisible
  // in exactly the place it would be caught.
  //
  // Only scalars are checked. The array settings deliberately fall back to `[]` against a
  // populated manifest default, because "nothing configured" and "the shipped ignore list"
  // are different answers there.
  const configSource = sources.find((file) => file.path.endsWith('config.ts'));
  assert.ok(configSource, 'expected src/core/config.ts');

  const properties = manifest.contributes.configuration.properties as Record<
    string,
    { default?: unknown }
  >;

  const fallbacks = [
    ...configSource.text.matchAll(/\bget<[^>]+>\(\s*'([^']+)'\s*,\s*([^),]+)\)/g)
  ];
  assert.ok(fallbacks.length > 0, 'expected config.ts to declare fallbacks');

  let compared = 0;
  for (const [, key, rawFallback] of fallbacks) {
    const declared = properties[`gitray.${key}`]?.default;
    if (declared === null || typeof declared === 'object') continue;

    const fallback = JSON.parse(rawFallback.trim().replace(/^'(.*)'$/, '"$1"')) as unknown;
    assert.equal(
      fallback,
      declared,
      `gitray.${key}: package.json defaults to ${JSON.stringify(declared)} but config.ts falls back to ${JSON.stringify(fallback)}`
    );
    compared++;
  }

  assert.ok(compared >= 8, `expected to compare most scalar settings, compared ${compared}`);
});

test('files referenced by the manifest and webview exist', () => {
  const referenced = [
    manifest.contributes.viewsContainers.activitybar[0].icon,
    'media/radar.css',
    'media/radar.js',
    'media/gitray.svg'
  ];

  for (const relative of referenced) {
    assert.ok(existsSync(join(root, relative)), `missing referenced file: ${relative}`);
  }
});

test('the manifest does not point at an icon that is absent', () => {
  // vsce refuses to package when `icon` names a file that does not exist, and the failure
  // only appears at publish time.
  if (manifest.icon) {
    assert.ok(existsSync(join(root, manifest.icon)), `manifest icon missing: ${manifest.icon}`);
  }
});

test('the tree view id matches what the extension registers', () => {
  const viewId = manifest.contributes.views.gitray[0].id;
  assert.ok(
    allSource.includes(`'${viewId}'`),
    `view "${viewId}" is contributed but never created`
  );
});

test('development-only directories are kept out of the package', () => {
  // A pattern that matches nothing fails silently: the files just ship. `scripts/` was
  // shipping inside the VSIX because `**/*.ts` happened to cover one file in it and
  // nothing covered the rest.
  const ignore = readFileSync(join(root, '.vscodeignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  for (const directory of ['src', 'test', 'scripts', 'fixtures', 'node_modules', '.vscode']) {
    assert.ok(
      ignore.includes(`${directory}/**`),
      `.vscodeignore should exclude ${directory}/**`
    );
  }
});

test('everything the extension needs at runtime is still packaged', () => {
  const ignore = readFileSync(join(root, '.vscodeignore'), 'utf8');

  // The inverse mistake — excluding something the extension loads at runtime — is worse,
  // because it only shows up once the published extension tries to open the Radar.
  for (const needed of ['media/', 'dist/', 'package.json', 'README']) {
    assert.doesNotMatch(
      ignore,
      new RegExp(`^${needed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'),
      `${needed} must not be excluded from the package`
    );
  }
});

test('the entry point named by main is what esbuild produces', () => {
  assert.equal(manifest.main, './dist/extension.js');
  const esbuild = readFileSync(join(root, 'esbuild.mjs'), 'utf8');
  assert.ok(esbuild.includes("outfile: 'dist/extension.js'"), 'bundle target has drifted');
  assert.ok(esbuild.includes("external: ['vscode']"), 'the vscode module must stay external');
});

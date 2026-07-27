/**
 * Test runner.
 *
 * Node 20's `--test` only auto-discovers .js files when handed a directory, and npm on
 * Windows runs scripts through cmd, which does not expand globs. So collect the files
 * here and pass them explicitly.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const dirs = ['test/unit', 'test/integration'];
const files = dirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => join(dir, name))
);

if (files.length === 0) {
  console.error(`No test files found in ${dirs.join(', ')}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--test', '--import', 'tsx', ...files],
  { stdio: 'inherit' }
);

process.exit(result.status ?? 1);

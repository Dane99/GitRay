import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !minify,
  minify,
  logLevel: 'info'
};

/**
 * The line-diff worker, a second bundle beside the first. It is started as a script of its
 * own, so it cannot live inside extension.js; see src/model/alignWorker.ts.
 */
/** @type {import('esbuild').BuildOptions} */
const worker = {
  ...options,
  entryPoints: ['src/model/alignWorker.ts'],
  outfile: 'dist/alignWorker.js',
  external: []
};

if (watch) {
  for (const build of [options, worker]) {
    const ctx = await esbuild.context(build);
    await ctx.watch();
  }
  console.log('[gitray] watching');
} else {
  await Promise.all([esbuild.build(options), esbuild.build(worker)]);
}

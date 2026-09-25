/**
 * Real-world performance runs, against large public GitHub repositories.
 *
 *   npm run perf                          every default testbed, this working tree
 *   npm run perf -- --testbed vscode      one testbed
 *   npm run perf -- --all                 the stress testbeds too
 *   npm run perf -- --src main            measure another build (any git ref)
 *   npm run perf -- --compare <summary>   show the change against an earlier run
 *   npm run perf -- --profile             write a CPU profile per phase
 *   npm run perf -- --refresh             re-record the open pull requests
 *   npm run perf -- --live                real GitHub API and network, not the recording
 *   npm run perf -- --list                what the testbeds are
 *
 * Exits non-zero when any phase goes over budget or any stability check fails, so it can
 * gate a release. See scripts/perf/README.md for what is measured and why.
 */

/* eslint-disable no-console */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BenchResult, PhaseResult } from './bench.js';
import { cacheDir, PROJECT_ROOT } from './prepare.js';
import { budgetFor, TESTBEDS, type Testbed } from './testbeds.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function selected(): Testbed[] {
  const named = option('testbed');
  if (named) {
    const ids = named.split(',').map((id) => id.trim());
    const unknown = ids.filter((id) => !TESTBEDS.some((testbed) => testbed.id === id));
    if (unknown.length > 0) throw new Error(`unknown testbed: ${unknown.join(', ')}`);
    return TESTBEDS.filter((testbed) => ids.includes(testbed.id));
  }
  return TESTBEDS.filter((testbed) => flag('all') || testbed.tier === 'default');
}

function list(): void {
  for (const testbed of TESTBEDS) {
    console.log(`${testbed.id.padEnd(12)} ${testbed.repo.padEnd(24)} ${testbed.tier.padEnd(8)} ${testbed.stresses}`);
  }
}

// --- Report -------------------------------------------------------------------------

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

function topCommands(phase: PhaseResult): string {
  return Object.entries(phase.spawnsByCommand)
    .slice(0, 3)
    .map(([command, count]) => `${command}×${count}`)
    .join(' ');
}

function printResult(result: BenchResult, baseline: BenchResult | undefined): void {
  console.log('');
  console.log(
    `${result.repo} — ${result.scenario.pullRequests} pull requests, ${result.scenario.editedFiles} files edited, ` +
      `${result.scenario.behind} behind · build ${result.build} (${result.buildCommit}) · ${result.mode} · ` +
      `timer floor ${result.environment.timerFloorMs} ms`
  );
  console.log(
    `  ${'phase'.padEnd(10)} ${pad('wall ms', 9)} ${pad('max block', 10)} ${pad('blocked', 8)} ${pad('git', 5)} ` +
      `${pad('analyses', 9)} ${pad('p95 input', 10)}  ${'busiest git'.padEnd(30)} verdict`
  );

  for (const phase of result.phases) {
    const before = baseline?.phases.find((candidate) => candidate.name === phase.name);
    const change = (now: number, then: number | undefined) =>
      then === undefined || then === 0 ? '' : ` (${now >= then ? '+' : ''}${Math.round(((now - then) / then) * 100)}%)`;
    const verdict = phase.violations.length > 0 ? `OVER: ${phase.violations.join('; ')}` : 'ok';
    console.log(
      `  ${phase.name.padEnd(10)} ${pad(phase.wallMs, 9)} ${pad(phase.maxBlockMs, 10)} ${pad(phase.blockedMs, 8)} ` +
        `${pad(phase.gitSpawns, 5)} ${pad(phase.analyses, 9)} ${pad(phase.handler?.p95Ms ?? '', 10)}  ` +
        `${topCommands(phase).padEnd(30)} ${verdict}`
    );
    if (before) {
      console.log(
        `  ${''.padEnd(10)} ${'vs baseline:'.padStart(9)} wall${change(phase.wallMs, before.wallMs)} ` +
          `block${change(phase.maxBlockMs, before.maxBlockMs)} git${change(phase.gitSpawns, before.gitSpawns)}`
      );
    }
  }

  for (const check of result.checks) {
    console.log(`  ${check.ok ? 'pass' : 'FAIL'}  ${check.name} — ${check.detail}`);
  }
  console.log(`  log: ${result.logPath}`);
}

// --- Main -----------------------------------------------------------------------------

function main(): number {
  if (flag('list')) {
    list();
    return 0;
  }

  const testbeds = selected();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir = join(cacheDir(), 'results', stamp);
  mkdirSync(resultsDir, { recursive: true });

  const baselinePath = option('compare');
  const baseline: BenchResult[] = baselinePath && existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : [];
  if (baselinePath && baseline.length === 0) console.warn(`no baseline results at ${baselinePath}`);

  const passthrough = ['refresh', 'live', 'profile'].filter(flag).map((name) => `--${name}`);
  const src = option('src');
  const results: BenchResult[] = [];
  let failed = false;

  for (const testbed of testbeds) {
    console.log(`\n▶ ${testbed.id}: ${testbed.repo} — ${testbed.stresses}`);
    const out = join(resultsDir, `${testbed.id}.json`);
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        join(__dirname, 'bench.ts'),
        '--testbed',
        testbed.id,
        '--out',
        out,
        ...(src ? ['--src', src] : []),
        ...passthrough
      ],
      { stdio: 'inherit', cwd: PROJECT_ROOT }
    );
    if (child.status !== 0 || !existsSync(out)) {
      console.error(`✗ ${testbed.id} did not complete`);
      failed = true;
      continue;
    }
    const result = JSON.parse(readFileSync(out, 'utf8')) as BenchResult;
    results.push(result);
  }

  const summary = join(resultsDir, 'summary.json');
  writeFileSync(summary, JSON.stringify(results, null, 2));

  for (const result of results) {
    printResult(result, baseline.find((candidate) => candidate.testbed === result.testbed));
    if (result.phases.some((phase) => phase.violations.length > 0)) failed = true;
    if (result.checks.some((check) => !check.ok)) failed = true;
  }

  console.log(`\nresults: ${summary}`);
  const budgets = testbeds.map((testbed) => `${testbed.id}: max block ≤ ${budgetFor(testbed, 'typing').maxBlockMs} ms while typing`);
  console.log(`budgets: ${budgets.join(', ')} (see scripts/perf/testbeds.ts)`);
  console.log(failed ? '\n✗ over budget or unstable' : '\n✓ within budget and stable');
  return failed ? 1 : 0;
}

process.exit(main());

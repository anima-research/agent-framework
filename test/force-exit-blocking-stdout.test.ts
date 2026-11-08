/**
 * `npm test` loads test/helpers/force-exit-blocking-stdout into the runner,
 * which passes it on to each test file's process, so --test-force-exit
 * can't drop the results still queued on a file's pipe to the runner
 * (agent-framework #294). The first test runs a fixture under the runner
 * with npm test's options and counts, in the runner's report, the bytes the
 * fixture's test wrote: a run of '~', which nothing else in the report
 * spells, and which the runner may pass on in pieces. The runner writes that
 * report to a file, not to a pipe as in npm test. Node writes a file
 * synchronously, so whatever the runner has handed to its stdout is in the
 * file when it exits. Through a pipe, the runner's own forced exit can drop
 * what is still queued for it, which the helper, acting only in a test
 * file's process, doesn't prevent. Where a run without the helper loses
 * nothing, as on a Node that carries nodejs/node#64875, there's nothing for
 * the helper to prevent, and the first two tests skip.
 */

import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const helper = new URL('./helpers/force-exit-blocking-stdout.js', import.meta.url).href;
const fixture = fileURLToPath(new URL('./fixtures/force-exit-stdout.mjs', import.meta.url));
const BYTES = 10_000_000;

/** How many '~' a report holds. */
function tildes(report: string): number {
  let n = 0;
  for (let i = 0; i < report.length; i++) if (report.charCodeAt(i) === 126) n++;
  return n;
}

/** This process's environment for a child, less the NODE_TEST_CONTEXT that would make it one of this runner's test files. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_EXIT_BYTES: String(BYTES) };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * How many of the fixture's bytes the runner's report holds, run with npm
 * test's options, with the helper loaded or not. With this fixture the runner
 * exits 0, so one that fails to start or exits otherwise throws, with the
 * end of its stderr and its report, rather than reading as a shortfall.
 */
function runnerReceived(withHelper: boolean): number {
  const args = [...(withHelper ? ['--import', helper] : []), '--test', '--test-force-exit', '--test-reporter=tap', fixture];
  const dir = mkdtempSync(join(tmpdir(), 'af-force-exit-report-'));
  try {
    const report = join(dir, 'report.tap');
    const fd = openSync(report, 'w');
    const run = (() => {
      try {
        return spawnSync(process.execPath, args, { env: childEnv(), stdio: ['ignore', fd, 'pipe'] });
      } finally {
        closeSync(fd);
      }
    })();
    if (run.error) throw run.error;
    const text = readFileSync(report, 'utf8');
    if (run.status !== 0) throw new Error(`the runner exited with ${run.status ?? run.signal}: ${(String(run.stderr) + text).slice(-2000)}`);
    return tildes(text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Bytes that reach a pipe from a plain process that writes BYTES to stdout and exits at once. */
function plainDelivered(withHelper: boolean): number {
  const script = `process.stdout.write('x'.repeat(${BYTES})); process.exit();`;
  return spawnSync(process.execPath, [...(withHelper ? ['--import', helper] : []), '-e', script], { env: childEnv(), maxBuffer: 2 * BYTES }).stdout.length;
}

test('a test file that exits at once after writing more than its pipe holds, as a forced exit does, delivers all of it to the runner', (t) => {
  if (runnerReceived(false) >= BYTES) {
    t.skip('without the helper, this run lost nothing at the exit: nothing to prevent');
    return;
  }
  assert.equal(runnerReceived(true), BYTES, "the runner's report holds what the test file wrote");
});

test('the helper leaves a process that isn\'t a test file\'s as it was', (t) => {
  if (plainDelivered(false) === BYTES) {
    t.skip('a plain process lost nothing at its exit here: nothing to tell apart');
    return;
  }
  assert.ok(plainDelivered(true) < BYTES, 'with the helper loaded outside a test file\'s process, its stdout was made blocking');
});

test('npm test loads the helper before --test --test-force-exit', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: { test: string } };
  // The runner gets the helper preloaded, and the flags it's written for.
  const args = pkg.scripts.test.split(/\s+/);
  const loads = args.findIndex((arg, i) => arg === '--import' && args[i + 1] === './dist/test/helpers/force-exit-blocking-stdout.js');
  const firstFile = args.findIndex((arg) => /\.test\.js$/.test(arg));
  assert.ok(loads >= 0 && firstFile > loads + 1 && args.includes('--test') && args.includes('--test-force-exit'), pkg.scripts.test);
});

/**
 * `npm test` passes --test-timeout=600000 to Node's runner. Under Node 22.12,
 * as under 20, the bound applies to each test file as a whole, from the file's
 * own start: a file still running at ten minutes is cancelled and fails by its
 * path, whether it's stuck in a test or while loading. Under Node 24 it
 * applies to each test and each hook: one still running at ten minutes fails,
 * and the report names its test or suite. A file stuck outside its tests and
 * hooks, such as while loading, runs on until CI's timeout-minutes ends the
 * job.
 *
 * Ten minutes is loose on purpose: the slowest file, mcpl-runtime-lifecycle,
 * took about three under Node 20, and a bound near that could fail a correct
 * change on a loaded runner.
 *
 * ci.yml's unforced step passes the same bound. Build & Test's time limit
 * stays at least a passing job's time above it, so that under Node 22.12 a file
 * that sticks within that time fails by name before GitHub cancels the job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const npmTest = (JSON.parse(read('package.json')) as { scripts: { test: string } }).scripts.test;
const npmTimeoutMs = Number(/ --test-timeout=(\d+) /.exec(npmTest)?.[1]);

// Passing Build & Test jobs took up to 6.5 minutes in 59 runs in October 2026.
const SLOWEST_PASSING_JOB_MS = 7 * 60_000;

/** A ci.yml job's timeout-minutes, from the lines between its key and the next one at its level. */
function jobMinutes(ci: string, job: string): number | undefined {
  const lines = ci.split('\n');
  const start = lines.indexOf(`  ${job}:`);
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) return undefined;
    const m = /^ {4}timeout-minutes: (\d+)\s*(?:#.*)?$/.exec(line);
    if (m) return Number(m[1]);
  }
  return undefined;
}

test('npm test passes --test-timeout=600000 to the runner, before the test files', () => {
  assert.match(npmTest, / --test-timeout=600000 dist\/test\/\*\.test\.js$/);
});

test("ci.yml's unforced node --test passes npm test's --test-timeout", () => {
  const ci = read('.github/workflows/ci.yml');
  const unforced = ci.split('\n').filter((line) => /^\s*run: node --test /.test(line));
  assert.equal(unforced.length, 1, 'ci.yml has one unforced node --test step');
  assert.equal(Number(/ --test-timeout=(\d+)(?: |$)/.exec(unforced[0])?.[1]), npmTimeoutMs);
});

test("Build & Test and the pack check have time limits, and Build & Test's leaves a passing job's time above the test timeout", () => {
  const ci = read('.github/workflows/ci.yml');
  const buildAndTest = jobMinutes(ci, 'build-and-test');
  assert.ok(buildAndTest !== undefined, 'build-and-test has a timeout-minutes');
  assert.ok(jobMinutes(ci, 'pack-check') !== undefined, 'pack-check has a timeout-minutes');
  assert.ok(
    buildAndTest * 60_000 >= npmTimeoutMs + SLOWEST_PASSING_JOB_MS,
    `build-and-test's ${buildAndTest} minutes leave less than a passing job's time above the ${npmTimeoutMs} ms test timeout`,
  );
});

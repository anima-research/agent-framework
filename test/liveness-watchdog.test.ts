import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WATCHDOG = pathToFileURL(join(import.meta.dirname, '../src/runtime/liveness-watchdog.js')).href;
const LONGER_THAN_ANY_START_MS = 60_000;
const NEVER_FIRES_IN_A_TEST_MS = 2 * LONGER_THAN_ANY_START_MS;

/** On Linux desktops the kernel pipes every SIGABRT of a packaged binary to a
 *  crash handler (apport), so the 'abort' case below produces a crash report
 *  and a desktop popup per run. RLIMIT_CORE == 1 is a kernel sentinel that
 *  disables piped core handling for the process, so wrap the child in
 *  `prlimit --core=1:1` when that tool is available. The child still dies by
 *  SIGABRT, which is all the test asserts. */
const PRLIMIT_PREFIX: string[] = (() => {
  if (process.platform !== 'linux') return [];
  const r = spawnSync('prlimit', ['--version'], { stdio: 'ignore' });
  return r.error ? [] : ['prlimit', '--core=1:1', '--'];
})();

function spawnChild(script: string) {
  const argv = [...PRLIMIT_PREFIX, process.execPath, script];
  return spawn(argv[0], argv.slice(1), { stdio: 'ignore' });
}

function runWedgedChild(action: 'exit' | 'abort', reportPath: string | null): Promise<{ code: number | null; signal: string | null; gaveUp: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), 'wd-'));
  const script = join(dir, 'child.mjs');
  writeFileSync(
    script,
    `
    import { LivenessWatchdog } from ${JSON.stringify(WATCHDOG)};
    const w = new LivenessWatchdog({
      enabled: true, thresholdMs: 400, heartbeatMs: 100,
      action: ${JSON.stringify(action)},
      reportPath: ${reportPath ? JSON.stringify(reportPath) : 'undefined'},
    });
    w.start();
    w.setPhase('test-wedge');
    setTimeout(() => { const end = Date.now() + ${NEVER_FIRES_IN_A_TEST_MS}; while (Date.now() < end) {} }, 300);
    `,
  );
  return new Promise((resolve) => {
    const child = spawnChild(script);
    let gaveUp = false;
    const giveUp = setTimeout(() => { gaveUp = true; child.kill('SIGKILL'); }, LONGER_THAN_ANY_START_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(giveUp);
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, signal, gaveUp });
    });
  });
}

const gaveUpMessage = `the wedged child hadn't ended by ${LONGER_THAN_ANY_START_MS} ms, so the test ended it`;

test("watchdog kills a wedged process (action: 'exit' → SIGKILL)", async () => {
  const { signal, gaveUp } = await runWedgedChild('exit', null);
  assert.ok(!gaveUp, gaveUpMessage);
  assert.strictEqual(signal, 'SIGKILL', `expected SIGKILL, got code/signal ${signal}`);
});

test("watchdog aborts a wedged process (action: 'abort' → SIGABRT) and writes a report", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-rep-'));
  const reportPath = join(dir, 'wedge.jsonl');
  try {
    const { signal, gaveUp } = await runWedgedChild('abort', reportPath);
    assert.ok(!gaveUp, gaveUpMessage);
    assert.strictEqual(signal, 'SIGABRT', `expected SIGABRT, got ${signal}`);
    assert.ok(existsSync(reportPath), 'wedge report file should exist');
    const rep = JSON.parse(readFileSync(reportPath, 'utf8').trim().split('\n')[0]);
    assert.strictEqual(rep.event, 'main-thread-wedged');
    assert.strictEqual(rep.phase, 'test-wedge');
    assert.ok(rep.ageMs >= 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const HEALTHY_WINDOW_MS = 1_500;

test('watchdog does NOT kill a healthy (heartbeating) process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-ok-'));
  const script = join(dir, 'ok.mjs');
  const checksPath = join(dir, 'checks.json');
  writeFileSync(
    script,
    `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    import { writeFileSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    import { LivenessWatchdog } from ${JSON.stringify(WATCHDOG)};
    const workerThreads = createRequire(import.meta.url)('node:worker_threads');
    const seen = { caught: false, checks: 0, lastCheckMs: null, exited: false };
    const report = () => writeFileSync(${JSON.stringify(checksPath)}, JSON.stringify(seen));
    let watchdog;
    let firstAt;
    let done;
    const ended = new Promise((resolve) => { done = resolve; });
    workerThreads.Worker = class extends workerThreads.Worker {
      constructor(filename, options) {
        if (!String(filename).includes('liveness-watchdog-worker')) { super(filename, options); return; }
        const href = pathToFileURL(String(filename)).href;
        super([
          "const { parentPort } = require('node:worker_threads');",
          'const realSetTimeout = globalThis.setTimeout;',
          'globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(() => { const at = Date.now(); fn(...args); parentPort.postMessage(at); }, ms);',
          'import(' + JSON.stringify(href) + ');',
        ].join('\\n'), { ...options, eval: true });
        watchdog = this;
        seen.caught = true;
        this.on('message', (at) => {
          seen.checks++;
          firstAt ??= at;
          seen.lastCheckMs = at - firstAt;
          if (at - firstAt >= ${HEALTHY_WINDOW_MS}) done();
        });
        this.once('exit', () => { seen.exited = true; done(); });
      }
    };
    syncBuiltinESMExports();
    const w = new LivenessWatchdog({ enabled: true, thresholdMs: 400, heartbeatMs: 100, action: 'exit' });
    w.start();
    if (!watchdog) { report(); process.exit(1); }
    watchdog.ref();
    await ended;
    report();
    process.exit(0);
    `,
  );
  try {
    const { code, signal, gaveUp } = await new Promise<{ code: number | null; signal: string | null; gaveUp: boolean }>((resolve) => {
      const child = spawn(process.execPath, [script], { stdio: 'ignore' });
      let gaveUp = false;
      const giveUp = setTimeout(() => { gaveUp = true; child.kill('SIGKILL'); }, LONGER_THAN_ANY_START_MS);
      child.on('exit', (code, signal) => { clearTimeout(giveUp); resolve({ code, signal, gaveUp }); });
    });
    assert.ok(!gaveUp, `the healthy child hadn't ended by ${LONGER_THAN_ANY_START_MS} ms, so the test ended it`);
    assert.strictEqual(signal, null, `healthy process should not be signalled; it got ${signal}`);
    assert.ok(existsSync(checksPath), `the healthy child ended with code ${code} before it recorded what it saw`);
    const seen: { caught: boolean; checks: number; lastCheckMs: number | null; exited: boolean } =
      JSON.parse(readFileSync(checksPath, 'utf8'));
    assert.ok(seen.caught, "the child saw the watchdog's worker start: it watches for a worker whose file names liveness-watchdog-worker");
    assert.ok(!seen.exited, `the watchdog's worker exited after ${seen.checks} checks` +
      (seen.lastCheckMs === null ? '' : `, the last ${seen.lastCheckMs} ms after its first`));
    assert.strictEqual(code, 0, `healthy process should exit cleanly; it exited ${code}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WATCHDOG = pathToFileURL(join(import.meta.dirname, '../src/runtime/liveness-watchdog.js')).href;

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

/** Spawn a child that starts the watchdog then wedges its main thread; resolve
 *  with how it died. */
function runWedgedChild(action: 'exit' | 'abort', reportPath: string | null): Promise<{ code: number | null; signal: string | null }> {
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
    // Heartbeat a few times, then wedge the main thread synchronously forever.
    setTimeout(() => { const end = Date.now() + 30000; while (Date.now() < end) {} }, 300);
    `,
  );
  return new Promise((resolve) => {
    const child = spawnChild(script);
    const killTimer = setTimeout(() => child.kill('SIGTERM'), 8000); // safety net
    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, signal });
    });
  });
}

test("watchdog kills a wedged process (action: 'exit' → SIGKILL)", async () => {
  const { signal } = await runWedgedChild('exit', null);
  assert.strictEqual(signal, 'SIGKILL', `expected SIGKILL, got code/signal ${signal}`);
});

test("watchdog aborts a wedged process (action: 'abort' → SIGABRT) and writes a report", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-rep-'));
  const reportPath = join(dir, 'wedge.jsonl');
  try {
    const { signal } = await runWedgedChild('abort', reportPath);
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

test('watchdog does NOT kill a healthy (heartbeating) process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-ok-'));
  const script = join(dir, 'ok.mjs');
  writeFileSync(
    script,
    `
    import { LivenessWatchdog } from ${JSON.stringify(WATCHDOG)};
    const w = new LivenessWatchdog({ enabled: true, thresholdMs: 400, heartbeatMs: 100, action: 'exit' });
    w.start();
    // stay alive and responsive for ~1.5s, never wedging, then exit cleanly
    setTimeout(() => { w.stop(); process.exit(0); }, 1500);
    `,
  );
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      const child = spawn(process.execPath, [script], { stdio: 'ignore' });
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.strictEqual(result.signal, null, 'healthy process should not be signalled');
    assert.strictEqual(result.code, 0, 'healthy process should exit cleanly');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

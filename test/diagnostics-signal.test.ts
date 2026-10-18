/**
 * `kill -USR2 <pid>` dumps each framework from partway through its create()
 * until its stop() stops the watchdog, through one listener the process keeps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentFramework, type Module } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

function tempDir(t: import('node:test').TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'diagnostics-signal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function config(storePath: string, agent?: string) {
  return { storePath, membrane: new MockMembrane().asMembrane(),
    agents: agent ? [{ name: agent, model: 'test', systemPrompt: 'test' }] : [],
    modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0 };
}

/** The [diagnostics] lines one SIGUSR2 prints, its listeners called as the signal calls them. */
function dump(t: import('node:test').TestContext): string[] {
  const lines: string[] = [];
  const logged = t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  try { process.emit('SIGUSR2', 'SIGUSR2'); } finally { logged.mock.restore(); }
  return lines.filter(line => line.startsWith('[diagnostics]'));
}

/** Each line's JSON, or its text when it isn't JSON, such as the line saying none is running. */
const parsed = (lines: string[]) => lines.map(line => {
  const text = line.slice('[diagnostics] '.length);
  try { return JSON.parse(text); } catch { return text; }
});
const agentsOf = (lines: string[]) => parsed(lines).map(dumped => typeof dumped === 'string' ? dumped : dumped.agents);

/** Resolve once `cond` holds, checking each turn; fail, naming `what`, after 5 s. */
async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

test('frameworks created and stopped one after another share one SIGUSR2 listener', async t => {
  const dir = tempDir(t);
  const before = process.listenerCount('SIGUSR2');
  for (let i = 0; i < 3; i++) {
    const framework = await AgentFramework.create(config(join(dir, `store-${i}`)));
    await framework.stop();
  }
  const after = process.listenerCount('SIGUSR2');
  assert.ok(after >= 1 && after - before <= 1, `${after - before} listeners added, ${after} installed`);
});

test('a SIGUSR2 dumps each framework while it runs, and says when none is running', async t => {
  const dir = tempDir(t);
  const first = await AgentFramework.create(config(join(dir, 'first'), 'first-agent'));
  const second = await AgentFramework.create(config(join(dir, 'second'), 'second-agent'));
  const both = dump(t);
  assert.deepEqual(agentsOf(both), [['first-agent'], ['second-agent']]);
  // connectome-doctor reads gate and activeStreams from a framework's line.
  for (const dumped of parsed(both)) {
    assert.deepEqual(Object.keys(dumped), ['at', 'gate', 'activeStreams', 'pendingRequests', 'agents']);
  }
  await first.stop();
  assert.deepEqual(agentsOf(dump(t)), [['second-agent']]);
  await second.stop();
  assert.deepEqual(dump(t), ['[diagnostics] no framework is running in this process']);
  // A create() refused after it joined (at toolResultInlineMaxChars) leaves
  // through stop(), in its release.
  await assert.rejects(AgentFramework.create({ ...config(join(dir, 'refused'), 'refused-agent'),
    toolResultInlineMaxChars: 1 }), /toolResultInlineMaxChars/);
  assert.deepEqual(dump(t), ['[diagnostics] no framework is running in this process']);
});

test("a framework stays in the dump while stop() waits on its own work, and leaves before its modules stop", async t => {
  const dir = tempDir(t);
  let moduleStopping = false;
  let releaseModule!: () => void;
  const held: Module = {
    name: 'held-stop',
    async start() {},
    stop() { moduleStopping = true; return new Promise<void>(resolve => { releaseModule = resolve; }); },
    async onProcess() { return {}; },
    getTools: () => [],
    async handleToolCall() { throw new Error('No tool calls expected'); },
  };
  const framework = await AgentFramework.create({ ...config(join(dir, 'store'), 'stopping-agent'), modules: [held] });
  // This framework's lines only, whatever another test left running.
  const its = (lines: string[]) => agentsOf(lines).filter(agents => Array.isArray(agents) && agents.includes('stopping-agent'));
  // stop() waits on a maintenance pass in flight, then on its event loop and
  // its operator operations, before it stops the watchdog. Hold the pass.
  let passAwaited = false;
  let releasePass!: () => void;
  const pass = new Promise<void>(resolve => { releasePass = resolve; });
  (framework as unknown as { maintenancePass: unknown }).maintenancePass = {
    then: (onFulfilled: () => unknown, onRejected: (error: unknown) => unknown) => {
      passAwaited = true;
      return pass.then(onFulfilled, onRejected);
    },
  };
  const stopping = framework.stop();
  await until(() => passAwaited, 'stop() to wait on the maintenance pass');
  assert.deepEqual(its(dump(t)), [['stopping-agent']], 'listed while stop() waits on the maintenance pass');
  releasePass();
  await until(() => moduleStopping, "stop() to reach its modules' teardown");
  assert.deepEqual(its(dump(t)), [], "not listed once stop() is tearing its modules down");
  releaseModule();
  await stopping;
});

// Control: passes on main, whose listeners are never removed. Removing a
// process's last SIGUSR2 listener would restore the signal's default action,
// which ends the process.
test('a SIGUSR2 after every framework has stopped leaves the process running', async t => {
  const dir = tempDir(t);
  const script = join(dir, 'child.mjs');
  const index = pathToFileURL(join(import.meta.dirname, '../src/index.js')).href;
  const membrane = pathToFileURL(join(import.meta.dirname, 'helpers/mock-membrane.js')).href;
  writeFileSync(script, `
    import { AgentFramework } from ${JSON.stringify(index)};
    import { MockMembrane } from ${JSON.stringify(membrane)};
    const framework = await AgentFramework.create({
      storePath: ${JSON.stringify(join(dir, 'store'))}, membrane: new MockMembrane().asMembrane(),
      agents: [], modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    await framework.stop();
    process.kill(process.pid, 'SIGUSR2');
    setTimeout(() => process.exit(0), 300);
  `);
  let timedOut = false;
  const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    const safety = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 20_000);
    child.on('exit', (code, signal) => { clearTimeout(safety); resolve({ code, signal }); });
  });
  assert.equal(timedOut, false, 'the child did not finish within 20 s');
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
});

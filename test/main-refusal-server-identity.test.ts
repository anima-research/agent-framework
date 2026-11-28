import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentFramework } from '../src/index.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { jsonLines } from './helpers/json-lines.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/reregistering-mcpl-server.mjs', import.meta.url));

// Same bounded file-coordination fixture as mcpl-reconnect-registration.test.ts.
async function waitFor(description: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

test('serverEpoch tracks config/connection objects: in-place crash reconnect preserves it, native restart replaces it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'main-refusal-identity-'));
  const eventsPath = join(dir, 'events.jsonl');
  const crashPath = join(dir, 'crash');
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'resident', model: 'mock', systemPrompt: 'offline fixture' }],
    modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    mcplServers: [{ id: 'chat', command: process.execPath, args: [FIXTURE],
      env: { EVENTS_PATH: eventsPath, CRASH_PATH: crashPath },
      enabledFeatureSets: ['chat'], reconnect: true, reconnectIntervalMs: 50 }],
  });
  try {
    const answers = () => jsonLines<{ event: string; pid: number; error?: unknown }>(eventsPath)
      .filter(e => e.event === 'register-answered');
    await waitFor('initial registration', () => answers().length === 1);
    const bridge = framework.getMainRefusalBridge();
    // Test-only inspection distinguishes an in-place reconnect from replacement.
    const registry = (framework as unknown as { mcplServerRegistry: McplServerRegistry }).mcplServerRegistry;
    assert.equal(bridge.serverEpoch('missing'), undefined);
    assert.equal(bridge.serverBinding('missing'), undefined);
    const connection = registry.getServer('chat');
    assert.ok(connection);
    const epoch = bridge.serverEpoch('chat');
    const binding = bridge.serverBinding('chat');
    const transportEpoch = connection.transportEpoch;
    const pid = answers()[0].pid;
    assert.ok(epoch); assert.ok(binding);
    assert.equal(bridge.serverEpoch('chat'), epoch, 'repeated reads are stable');

    writeFileSync(crashPath, '');
    await waitFor('registration after in-place reconnect', () => answers().length === 2);
    assert.equal(answers()[1].error, null);
    assert.notEqual(answers()[1].pid, pid, 'a fresh child, not just a fake epoch swap');
    assert.equal(registry.getServer('chat'), connection);
    assert.notEqual(connection.transportEpoch, transportEpoch);
    assert.equal(bridge.serverEpoch('chat'), epoch, 'NOT transport/child/reconnect identity');
    assert.equal(bridge.serverBinding('chat'), binding);

    await framework.restartMcplServer('chat');
    await waitFor('registration after native restart', () => answers().length === 3);
    assert.notEqual(registry.getServer('chat'), connection);
    assert.ok(bridge.serverEpoch('chat'));
    assert.notEqual(bridge.serverEpoch('chat'), epoch, 'connection object replacement invalidates identity');
    assert.equal(bridge.serverBinding('chat'), binding, 'same endpoint alone does not preserve epoch');
  } finally { await framework.stop(); rmSync(dir, { recursive: true, force: true }); }
});

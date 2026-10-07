/**
 * ModuleContext.addMessage options: a module can deliver into a named
 * agent's window under that agent's turn guard, learn where the message
 * went, and ask for a deferral to survive a restart.
 *
 * Deferral is unchanged: the same guard decides when a message is held and
 * when it lands. `durable` keeps a held message in the persisted recovery
 * queue (the one quiesce uses) instead of memory, and passes a message stored
 * at once through that queue to a sync, so either replays exactly once after
 * a crash. Only a delivery proven durable says so.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentFramework } from '../src/index.js';
import type { MessagePlacement, Module, ModuleContext, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

class Courier implements Module {
  readonly name = 'courier';
  ctx!: ModuleContext;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: true }; }
  async onProcess(): Promise<Record<string, never>> { return {}; }
}

type Internals = { activeTurnTokens: Map<string, number> };

const texts = (framework: AgentFramework, agent: string) =>
  (framework.getAgent(agent)!.getContextManager().getAllMessages() as Array<{
    content: Array<{ text?: string }>; metadata?: { deferredWriteId?: string };
  }>).map((m) => ({ text: m.content[0]?.text, deferredWriteId: m.metadata?.deferredWriteId }));

describe('ModuleContext.addMessage delivery options', () => {
  let tempDir: string;
  let storePath: string;
  let courier: Courier;
  let framework: AgentFramework;
  let quiet: typeof console.log;
  let quietErr: typeof console.error;

  const open = async () => {
    courier = new Courier();
    framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [
        { name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' },
        { name: 'other', model: 'test-model', systemPrompt: 'You are other.' },
      ],
      modules: [courier],
    });
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'module-delivery-'));
    storePath = join(tempDir, 'test.chronicle');
    quiet = console.log;
    quietErr = console.error;
    console.log = () => {};
    console.error = () => {};
    await open();
  });
  afterEach(async () => {
    await framework.stop();
    console.log = quiet;
    console.error = quietErr;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('lands in the named idle agent at once, and the placement says where', async () => {
    const placement: MessagePlacement = {};
    const id = courier.ctx.addMessage('user', [{ type: 'text', text: 'for other' }], undefined, { forAgent: 'other', placement });
    assert.ok(id, 'stored, with an id');
    assert.deepEqual(placement, { agent: 'other', messageId: id, durable: false }, 'stored, not yet proven durable');
    assert.deepEqual(texts(framework, 'other').map((m) => m.text), ['for other']);
  });

  it('passes a durable message stored at once through the recovery queue to a sync', async () => {
    const placement: MessagePlacement = {};
    const id = courier.ctx.addMessage('user', [{ type: 'text', text: 'proven' }], undefined, { forAgent: 'other', placement, durable: true });
    assert.deepEqual(placement, { agent: 'other', messageId: id, durable: true });
    const internals = framework as unknown as { unackedDeferredWrites: unknown[]; deferredMessages: unknown[] };
    assert.equal(internals.unackedDeferredWrites.length, 0, 'acknowledged by the sync');
    assert.equal(internals.deferredMessages.length, 0);
    assert.deepEqual(texts(framework, 'other').map((m) => m.text), ['proven'], 'stored once');
  });

  it('keeps a durable message stored at once queued when its sync fails, and still says durable', async () => {
    const store = framework.getStore() as unknown as { sync: () => void };
    const realSync = store.sync.bind(store);
    store.sync = () => { throw new Error('injected sync failure'); };
    const placement: MessagePlacement = {};
    try {
      courier.ctx.addMessage('user', [{ type: 'text', text: 'queued' }], undefined, { forAgent: 'other', placement, durable: true });
    } finally {
      store.sync = realSync;
    }
    assert.equal(placement.durable, true, 'held in the persisted queue for exactly-once replay');
    const internals = framework as unknown as { unackedDeferredWrites: Array<{ id: string }> };
    assert.equal(internals.unackedDeferredWrites.length, 1, 'still queued, awaiting a sync');
  });

  it("holds a targeted message for the target's turn even when the primary is idle", async () => {
    // The guard is the target's: other mid-turn defers it although scout,
    // the primary, has no turn alive.
    (framework as unknown as Internals).activeTurnTokens.set('other', 77);
    const placement: MessagePlacement = {};
    assert.equal(courier.ctx.addMessage('user', [{ type: 'text', text: 'held for other' }], undefined, { forAgent: 'other', placement }), '');
    assert.equal(placement.agent, 'other');
    // And an untargeted message for the idle primary is not held by other's turn.
    const direct: MessagePlacement = {};
    assert.ok(courier.ctx.addMessage('user', [{ type: 'text', text: 'for the primary' }], undefined, { placement: direct }));
    assert.equal(direct.agent, 'scout');
    assert.equal(typeof direct.messageId, 'string');
  });

  it("waits behind the target's live turn, then lands carrying its deferred-write id", async () => {
    (framework as unknown as Internals).activeTurnTokens.set('other', 77);
    const placement: MessagePlacement = {};
    const id = courier.ctx.addMessage('user', [{ type: 'text', text: 'after your turn' }], undefined, { forAgent: 'other', placement });
    assert.equal(id, '', 'deferred');
    assert.equal(placement.agent, 'other');
    assert.equal(typeof placement.deferredId, 'string');
    assert.equal(placement.durable, false, 'not asked to be durable: memory only');
    assert.deepEqual(texts(framework, 'other'), []);

    (framework as unknown as Internals).activeTurnTokens.delete('other'); // the turn ends
    await framework.runAtSafeBoundary({ verb: 'boundary' }, async () => {}); // a boundary flush
    assert.deepEqual(texts(framework, 'other'), [{ text: 'after your turn', deferredWriteId: placement.deferredId }]);
  });

  it('keeps a durable deferral through a crash, and lands it exactly once', async () => {
    (framework as unknown as Internals).activeTurnTokens.set('other', 77);
    const placement: MessagePlacement = {};
    courier.ctx.addMessage('user', [{ type: 'text', text: 'must not be lost' }], undefined, { forAgent: 'other', placement, durable: true });
    assert.equal(placement.durable, true, 'persisted');
    const queuePath = join(storePath, 'recovery', 'deferred-writes.json');
    const queued = JSON.parse(readFileSync(queuePath, 'utf8')) as { pending: Array<{ id: string; forAgent?: string }> };
    assert.deepEqual(queued.pending.map((p) => ({ id: p.id, forAgent: p.forAgent })), [{ id: placement.deferredId, forAgent: 'other' }]);

    await framework.stop(); // crash-equivalent: the turn never ended and nothing flushed
    await open();
    assert.deepEqual(texts(framework, 'other'), [{ text: 'must not be lost', deferredWriteId: placement.deferredId }], 'landed at boot');
    await framework.stop();
    await open();
    assert.deepEqual(texts(framework, 'other').map((m) => m.text), ['must not be lost'], 'still exactly once after a second reopen');
  });

  it('leaves a deferral that did not ask to be durable in memory, as before', async () => {
    (framework as unknown as Internals).activeTurnTokens.set('other', 77);
    const placement: MessagePlacement = {};
    courier.ctx.addMessage('user', [{ type: 'text', text: 'best effort' }], undefined, { forAgent: 'other', placement });
    assert.equal(placement.durable, false);
    const queuePath = join(storePath, 'recovery', 'deferred-writes.json');
    assert.equal(existsSync(queuePath) && (JSON.parse(readFileSync(queuePath, 'utf8')) as { pending: unknown[] }).pending.length > 0, false);
    await framework.stop();
    await open();
    assert.deepEqual(texts(framework, 'other'), [], 'lost with the process, as memory-only deferrals always were');
  });

  it('drops a message for an unknown agent, and the empty placement says so', async () => {
    const placement: MessagePlacement = {};
    const id = courier.ctx.addMessage('user', [{ type: 'text', text: 'to nobody' }], undefined, { forAgent: 'ghost', placement, durable: true });
    assert.equal(id, '');
    assert.deepEqual(placement, {});
  });

  it('describes only the latest call in a reused placement receipt', async () => {
    const placement: MessagePlacement = {};
    courier.ctx.addMessage('user', [{ type: 'text', text: 'one' }], undefined, { forAgent: 'scout', placement });
    assert.equal(typeof placement.messageId, 'string');
    courier.ctx.addMessage('user', [{ type: 'text', text: 'lost' }], undefined, { forAgent: 'ghost', placement, durable: true });
    assert.deepEqual(placement, {}, 'nothing left from the earlier delivery');

    courier.ctx.addMessage('user', [{ type: 'text', text: 'two' }], undefined, { forAgent: 'other', placement });
    (framework as unknown as Internals).activeTurnTokens.set('other', 77);
    courier.ctx.addMessage('user', [{ type: 'text', text: 'three' }], undefined, { forAgent: 'other', placement });
    assert.equal(placement.messageId, undefined, 'no stale message id beside the deferral');
    assert.equal(typeof placement.deferredId, 'string');
    assert.equal(placement.durable, false);
  });
});

describe('ModuleContext.addMessage durable delivery across a hard kill', () => {
  it('keeps a durable message stored at once, exactly once, when the process is killed right after the call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'module-delivery-kill-'));
    const index = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const mock = fileURLToPath(new URL('./helpers/mock-membrane.js', import.meta.url));
    const script = join(dir, 'child.mjs');
    writeFileSync(script, `
      import { AgentFramework } from ${JSON.stringify(index)};
      import { MockMembrane } from ${JSON.stringify(mock)};
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const [mode, dir] = process.argv.slice(2);
      const courier = { name: 'courier', async start(c) { this.ctx = c; }, async stop() {}, getTools() { return []; },
        async handleToolCall() { return { success: true }; }, async onProcess() { return {}; } };
      console.log = () => {}; console.error = () => {};
      const fw = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'test' }], modules: [courier] });
      if (mode === 'deliver') {
        fw.getStore().sync();
        const placement = {};
        courier.ctx.addMessage('user', [{ type: 'text', text: 'DURABLE_IMMEDIATE_NOTICE' }], undefined, { forAgent: 'scout', durable: true, placement });
        writeFileSync(join(dir, 'receipt.json'), JSON.stringify(placement));
        process.kill(process.pid, 'SIGKILL');
      } else {
        const all = JSON.stringify(fw.getAgent('scout').getContextManager().getAllMessages());
        writeFileSync(join(dir, 'count.json'), JSON.stringify(all.split('DURABLE_IMMEDIATE_NOTICE').length - 1));
        await fw.stop();
        process.exit(0);
      }
    `);
    try {
      const killed = spawnSync(process.execPath, [script, 'deliver', dir], { encoding: 'utf8' });
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')) as MessagePlacement;
      assert.equal(receipt.durable, true);
      const reopened = spawnSync(process.execPath, [script, 'check', dir], { encoding: 'utf8' });
      assert.equal(reopened.status, 0, reopened.stderr);
      assert.equal(JSON.parse(readFileSync(join(dir, 'count.json'), 'utf8')), 1, 'present after the kill, exactly once');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

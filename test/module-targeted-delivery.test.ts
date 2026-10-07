/**
 * ModuleContext.addMessage options: a module can deliver into a named
 * agent's window under that agent's turn guard, learn where the message
 * went, and ask for a deferral to survive a restart.
 *
 * Deferral is unchanged: the same guard decides when a message is held and
 * when it lands. `durable` only keeps a held message in the persisted
 * recovery queue (the one quiesce uses) instead of memory, so it replays
 * exactly once after a crash.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
    assert.deepEqual(placement, { agent: 'other', messageId: id, durable: true });
    assert.deepEqual(texts(framework, 'other').map((m) => m.text), ['for other']);
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
});

/**
 * FrameworkConfig.presentationIndex (#291), as this release ships it: the
 * presentation module is constructed under the flag and checks each write's
 * audience stamp, and nothing presents yet. With the flag off, no window
 * index is written and the requests are what they were; with it on, they
 * are the same, every agent's context stays in legacy mode, and a write
 * stamped only for agents that can't read its slot is traced once.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, type MessageId, type MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, audienceOf, type EventResponse, type Module, type ProcessEvent, type ToolCall, type TraceEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

class Tools implements Module {
  readonly name = 'test';
  async start() {}
  async stop() {}
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'Antra', content: [{ type: 'text', text: 'hello' }] }], requestInference: ['mira'] };
  }
  getTools() { return [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' as const, properties: {} } }]; }
  async handleToolCall(_call: ToolCall) { return { success: true, data: { echoed: true } }; }
}

/** Two residents; mira's turn makes a tool round, then answers. */
async function run(presentationIndex: boolean | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'af-presentation-flag-'));
  dirs.push(dir);
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([
    { type: 'text', text: 'Calling.' },
    { type: 'tool_use', id: 'c1', name: 'test--echo', input: {} },
  ] as ContentBlock[], 'tool_use'));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }] as ContentBlock[]));
  const traces: TraceEvent[] = [];
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [
      { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', allowedTools: 'all', proseRouting: 'disabled' },
      { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.', proseRouting: 'disabled' },
    ],
    modules: [new Tools()],
    syncIntervalMs: 0,
    ...(presentationIndex !== undefined ? { presentationIndex } : {}),
  });
  framework.onTrace((event) => { traces.push(event); });
  framework.start();
  const internals = framework as unknown as {
    addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string; audience?: readonly string[] }): MessageId;
  };
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
  await framework.runUntilIdle();
  return { framework, membrane, traces, internals, store: framework.getStore() };
}

/** What each request carried: its system prompt and messages. */
const requests = (membrane: MockMembrane) => membrane.calls.map((c) => JSON.stringify({ system: c.system, messages: c.messages }));

describe('FrameworkConfig.presentationIndex', () => {
  it('off by default: no window index is written, and on, unwired, the requests are the same', async () => {
    const off = await run(undefined);
    const on = await run(true);
    try {
      assert.equal(off.membrane.lastStream?.receivedToolResults.length, 1, 'the turn made its tool round and answered');
      assert.deepEqual(requests(on.membrane), requests(off.membrane), 'byte for byte, request by request');
      assert.equal(JSON.stringify(on.membrane.lastStream?.receivedToolResults), JSON.stringify(off.membrane.lastStream?.receivedToolResults),
        'and the round was given the same results');
      for (const r of [off, on]) {
        for (const name of ['mira', 'oren']) {
          assert.equal(r.store.getStateLen(`agents/${name}/window`) ?? 0, 0, `no window index for ${name}`);
          assert.equal(r.framework.getAgent(name)!.getContextManager().windowMode(), 'legacy', `${name} is in legacy mode`);
        }
        assert.deepEqual(r.traces.filter((t) => t.type.startsWith('presentation:')), [], 'nothing presented');
      }
    } finally {
      await off.framework.stop();
      await on.framework.stop();
    }
  });

  it("on, a write stamped only for agents that can't read its slot is traced once, and stored as named", async () => {
    const on = await run(true);
    const off = await run(false);
    try {
      const id = on.internals.addMessage('someone', [{ type: 'text', text: 'for a worker' }], undefined, { audience: ['worker-9'] });
      const faults = on.traces.filter((t): t is Extract<TraceEvent, { type: 'presentation:unreadable-audience' }> =>
        t.type === 'presentation:unreadable-audience');
      assert.deepEqual(faults.map((t) => [t.audience, t.slot, t.deliveredTo]), [[['worker-9'], { namespace: null }, 'mira']]);
      const row = on.framework.getAgent('mira')!.getContextManager().getMessage(id)!;
      assert.deepEqual(audienceOf(row.metadata)?.audience, ['worker-9'], 'never widened');
      on.internals.addMessage('someone', [{ type: 'text', text: 'for oren' }], undefined, { forAgent: 'oren' });
      assert.equal(on.traces.filter((t) => t.type === 'presentation:unreadable-audience').length, 1, 'a readable stamp is no fault');
      off.internals.addMessage('someone', [{ type: 'text', text: 'for a worker' }], undefined, { audience: ['worker-9'] });
      assert.deepEqual(off.traces.filter((t) => t.type.startsWith('presentation:')), [], 'off, nothing is checked');
    } finally {
      await on.framework.stop();
      await off.framework.stop();
    }
  });

  it("is refused where context-manager doesn't keep a window index", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-presentation-flag-'));
    dirs.push(dir);
    const proto = ContextManager.prototype as unknown as { presentRows?: unknown };
    const presentRows = proto.presentRows;
    proto.presentRows = undefined;
    try {
      await assert.rejects(AgentFramework.create({
        storePath: join(dir, 'store.chronicle'),
        membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' }],
        modules: [],
        presentationIndex: true,
      }), /presentationIndex needs @animalabs\/context-manager with ContextManager\.presentRows/);
    } finally {
      proto.presentRows = presentRows;
    }
  });
});

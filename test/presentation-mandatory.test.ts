/**
 * Presentation is mandatory (#291, AF-6): FrameworkConfig.presentationIndex
 * is gone, and every agent is taken on as it is registered, its window
 * written down and presented, whatever a host's configuration still says. A
 * turn's requests are its window, which with no other agent's turn
 * overlapping it is the record, and a write stamped only for agents that
 * can't read its slot is traced once. A context-manager that keeps no
 * window index is refused, and a store handle without chronicle's batched
 * identity append is warned of once.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
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

/** Two residents; mira's turn makes a tool round, then answers. `extra` is
 *  spread into the configuration as a host's own would be, untyped. */
async function run(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-presentation-mandatory-'));
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
    ...extra,
  } as Parameters<typeof AgentFramework.create>[0]);
  framework.onTrace((event) => { traces.push(event); });
  framework.start();
  const internals = framework as unknown as {
    addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string; audience?: readonly string[] }): MessageId;
  };
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
  await framework.runUntilIdle();
  return { framework, membrane, traces, internals, store: framework.getStore() };
}

describe('presentation is mandatory (#291)', () => {
  // A host may still pass the option an earlier release took: it is read as
  // any unknown key is, and turns nothing off.
  for (const [label, extra] of [['with no option', {}], ["with the removed presentationIndex: false a host's configuration still passes", { presentationIndex: false }]] as const) {
    it(`each agent's window is written down at its registration and presented, ${label}`, async () => {
      const r = await run(extra);
      try {
        assert.equal(r.membrane.lastStream?.receivedToolResults.length, 1, 'the turn made its tool round and answered');
        for (const name of ['mira', 'oren']) {
          assert.ok((r.store.getStateLen(`agents/${name}/window`) ?? 0) > 0, `a window index for ${name}`);
          assert.equal(r.framework.getAgent(name)!.getContextManager().windowMode(), 'presented', `${name}'s window is presented`);
        }
        assert.ok(r.traces.some((t) => t.type === 'presentation:presented'), 'rows presented');
        // mira's window holds every row of its turn, in the order its requests carried them.
        const cm = r.framework.getAgent('mira')!.getContextManager();
        assert.deepEqual(cm.getPresentedMessages().map((m) => m.id), cm.getAllMessages().map((m) => m.id),
          "with no other turn in the slot, mira's window is the record");
      } finally {
        await r.framework.stop();
      }
    });
  }

  it("a write stamped only for agents that can't read its slot is traced once, and stored as named", async () => {
    const r = await run();
    try {
      const id = r.internals.addMessage('someone', [{ type: 'text', text: 'for a worker' }], undefined, { audience: ['worker-9'] });
      const faults = r.traces.filter((t): t is Extract<TraceEvent, { type: 'presentation:unreadable-audience' }> =>
        t.type === 'presentation:unreadable-audience');
      assert.deepEqual(faults.map((t) => [t.audience, t.slot, t.deliveredTo]), [[['worker-9'], { namespace: null }, 'mira']]);
      const row = r.framework.getAgent('mira')!.getContextManager().getMessage(id)!;
      assert.deepEqual(audienceOf(row.metadata)?.audience, ['worker-9'], 'never widened');
      r.internals.addMessage('someone', [{ type: 'text', text: 'for oren' }], undefined, { forAgent: 'oren' });
      assert.equal(r.traces.filter((t) => t.type === 'presentation:unreadable-audience').length, 1, 'a readable stamp is no fault');
    } finally {
      await r.framework.stop();
    }
  });

  // On a chronicle without the identity-stamped batched append (before
  // 0.5.0), every window write is one record per row: a host runs, and an
  // operator hears of the cost once, at create(), before any write-down.
  for (const batched of [false, true]) {
    it(batched
      ? 'says nothing of the store when its handle has the batched identity append'
      : 'warns once at create() when the store handle has no batched identity append, naming the chronicle and the cost', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'af-presentation-mandatory-'));
      dirs.push(dir);
      const store = JsStore.openOrCreate({ path: join(dir, 'store.chronicle') });
      // A handle without the method, as chronicle 0.4 gives one.
      if (!batched) (store as unknown as { appendManyToStateJsonWithIdentity?: unknown }).appendManyToStateJsonWithIdentity = undefined;
      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
      const membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }] as ContentBlock[]));
      let framework: AgentFramework | undefined;
      try {
        framework = await AgentFramework.create({
          store,
          membrane: membrane.asMembrane(),
          agents: [
            { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', proseRouting: 'disabled' },
            { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.', proseRouting: 'disabled' },
          ],
          modules: [new Tools()],
          syncIntervalMs: 0,
          operatorLogPath: false,
        });
        const alerts: Array<Extract<TraceEvent, { type: 'ops:alert' }>> = [];
        framework.onTrace((event) => { if (event.type === 'ops:alert') alerts.push(event); }, { replay: true });
        framework.start();
        framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
        await framework.runUntilIdle();
        assert.equal(framework.getAgent('mira')!.getContextManager().windowMode(), 'presented', 'the host runs either way');
        const said = warnings.filter((line) => line.includes('appendManyToStateJsonWithIdentity'));
        const raised = alerts.filter((alert) => alert.kind === 'chronicle-per-row-window-writes');
        if (batched) {
          assert.deepEqual(said, []);
          assert.deepEqual(raised, []);
          return;
        }
        assert.equal(said.length, 1, 'one warning for the process');
        assert.equal(raised.length, 1, 'and one ops alert');
        const version = (JSON.parse(readFileSync(join(import.meta.dirname, '../../node_modules/@animalabs/chronicle/package.json'), 'utf8')) as { version: string }).version;
        assert.match(said[0]!, new RegExp(`chronicle ${version.replace(/\./g, '\\.')} is loaded`), 'naming the chronicle it loads');
        assert.match(said[0]!, /one record per row/);
        assert.match(said[0]!, /23 s and 63 MB/, 'and the cost');
        assert.match(said[0]!, /\^0\.5\.0/);
        assert.equal(raised[0]!.agentName, 'framework');
        assert.deepEqual(raised[0]!.data, { chronicle: version, missing: 'appendManyToStateJsonWithIdentity' });
      } finally {
        console.warn = warn;
        await framework?.stop();
        store.close();
      }
    });
  }

  it("is refused where context-manager doesn't keep a window index", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-presentation-mandatory-'));
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
      }), (error: Error) => {
        assert.match(error.message, /agent-framework needs @animalabs\/context-manager with ContextManager\.presentRows/);
        // The release it names is the one package.json declares.
        const declared = (JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as {
          dependencies: Record<string, string>;
        }).dependencies['@animalabs/context-manager']!;
        assert.ok(error.message.includes(`Install @animalabs/context-manager ${declared}, which this package declares`), error.message);
        return true;
      });
    } finally {
      proto.presentRows = presentRows;
    }
  });
});

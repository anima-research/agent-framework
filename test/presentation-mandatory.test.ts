/**
 * Presentation is mandatory (#291, AF-6): there is no option for it, and
 * every agent is taken on as it is registered, its window written down and
 * presented, whatever a host's configuration still says (one whose
 * write-down fails stays in legacy mode, its window the record, until a
 * branch move: review8-presentation). A
 * turn's requests are its window, and a request-only `[Continue]` where the
 * window ends on its own reply. The window is the record when nothing
 * arrives for the agent during a turn and every row in the slot is meant
 * for it, and a write stamped only for agents that can't read its slot is
 * traced once. A
 * context-manager that keeps no window index is refused, and so is a store
 * handle without chronicle's batched identity append, with which
 * context-manager writes a window. The package loads on context-manager
 * 0.24.0 for create() to say so: no module names an export 0.25.0 added in
 * an import from it.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, type MessageId, type MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, audienceOf, type EventResponse, type Module, type ProcessEvent, type ToolCall, type TraceEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { ADDED_IN_0_25 } from './helpers/context-manager-0.24.js';

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

/** An import or re-export of named items from context-manager, with either quote: the items are group 2, `type` group 1. */
const CONTEXT_MANAGER_IMPORT = /(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])@animalabs\/context-manager\3/g;

describe('presentation is mandatory (#291)', () => {
  // A host may pass presentationIndex, the option this work's earlier
  // commits took and no release had: it is read as any unknown key is, and
  // turns nothing off.
  for (const [label, extra] of [['with no option', {}], ['with presentationIndex: false, a key no release took', { presentationIndex: false }]] as const) {
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
          "with no other turn in the slot and every row in it meant for her, mira's window is the record");
      } finally {
        await r.framework.stop();
      }
    });
  }

  // AF-A-1: a host that ran with mira alone, restarted with oren added. oren's
  // window is written down at its registration from the shared record, and
  // takes in none of mira's own rows or her mail (decision 1).
  it("a resident added after a host ran without it holds none of the other resident's own rows or mail", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-presentation-mandatory-'));
    dirs.push(dir);
    const storePath = join(dir, 'store.chronicle');
    const agent = (name: string) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.`, proseRouting: 'disabled' as const });
    const textOf = (m: { content: ContentBlock[] }) => m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : '')).join('');
    {
      const membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([{ type: 'text', text: "mira's private reply" }] as ContentBlock[]));
      const framework = await AgentFramework.create({
        storePath, membrane: membrane.asMembrane(), agents: [agent('mira')], modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      });
      try {
        framework.start();
        const internals = framework as unknown as { addMessage(p: string, c: ContentBlock[], m?: MessageMetadata, o?: { forAgent?: string }): MessageId };
        internals.addMessage('alice', [{ type: 'text', text: 'a DM for mira alone' }] as ContentBlock[], undefined, { forAgent: 'mira' });
        assert.equal(framework.nudgeAgent('mira', 'zz-op').ok, true);
        await framework.runUntilIdle();
        const window = framework.getAgent('mira')!.getContextManager().getPresentedMessages().map(textOf);
        assert.ok(window.includes('a DM for mira alone') && window.includes("mira's private reply"), `setup: ${JSON.stringify(window)}`);
      } finally {
        await framework.stop();
      }
    }
    const framework = await AgentFramework.create({
      storePath, membrane: new MockMembrane().asMembrane(), agents: [agent('mira'), agent('oren')], modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    try {
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); }, { replay: true });
      const oren = framework.getAgent('oren')!.getContextManager();
      assert.equal(oren.windowMode(), 'presented');
      const window = oren.getPresentedMessages().map(textOf);
      assert.ok(!window.includes('a DM for mira alone'), `mira's mail isn't in oren's window: ${JSON.stringify(window)}`);
      assert.ok(!window.includes("mira's private reply"), `nor mira's reply: ${JSON.stringify(window)}`);
      const compiled = JSON.stringify((await oren.compile(undefined, undefined, { dryRun: true })).messages);
      assert.ok(!compiled.includes('a DM for mira alone') && !compiled.includes("mira's private reply"), "nor oren's compile");
      const retracted = traces.filter((t): t is Extract<TraceEvent, { type: 'presentation:retracted' }> => t.type === 'presentation:retracted');
      assert.deepEqual(retracted.map((t) => [t.agentName, t.reason]), [['oren', 'elsewhere']]);
      const mira = framework.getAgent('mira')!.getContextManager().getPresentedMessages().map(textOf);
      assert.ok(mira.includes('a DM for mira alone') && mira.includes("mira's private reply"), "mira's window keeps both");
    } finally {
      await framework.stop();
    }
  });

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

  // Context-manager writes a window write of several rows as one record,
  // through chronicle's identity-stamped batched append (chronicle 0.6.0 on),
  // and has no one-record-per-row path: on a handle without it, the first
  // write-down of a record that holds a row throws. create() refuses such a
  // handle before any agent is registered, naming the chronicle and the range.
  it('is refused at create() where the store handle has no batched identity append, naming the chronicle and the range', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-presentation-mandatory-'));
    dirs.push(dir);
    const store = JsStore.openOrCreate({ path: join(dir, 'store.chronicle') });
    // A handle without the method, as chronicle 0.5.0 gives one.
    (store as unknown as { appendManyToStateJsonWithIdentity?: unknown }).appendManyToStateJsonWithIdentity = undefined;
    const manifestOf = (path: string) => JSON.parse(readFileSync(join(import.meta.dirname, path), 'utf8')) as {
      version: string; dependencies: Record<string, string>;
    };
    const version = manifestOf('../../node_modules/@animalabs/chronicle/package.json').version;
    const declared = manifestOf('../../package.json').dependencies['@animalabs/chronicle']!;
    // AF #844 bot review 4, finding 72: refused before create() writes
    // anything, the framework's state registrations included.
    const states = () => store.listStates().map((s) => s.id).sort();
    const before = states();
    try {
      await assert.rejects(AgentFramework.create({
        store,
        membrane: new MockMembrane().asMembrane(),
        agents: [
          { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', proseRouting: 'disabled' },
          { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.', proseRouting: 'disabled' },
        ],
        modules: [new Tools()],
        syncIntervalMs: 0,
        operatorLogPath: false,
      }), (error: Error) => {
        assert.match(error.message, /^agent-framework needs a store handle with JsStore\.appendManyToStateJsonWithIdentity/);
        assert.ok(error.message.includes(`this package loads @animalabs/chronicle ${version}`), `naming the chronicle it loads: ${error.message}`);
        assert.ok(error.message.includes(`Install @animalabs/chronicle ${declared}, which this package declares`), error.message);
        return true;
      });
      for (const name of ['mira', 'oren']) {
        assert.equal(store.getStateLen(`agents/${name}/window`) ?? 0, 0, `nothing written to ${name}'s window`);
      }
      assert.deepEqual(states(), before, 'no state registered: the refusal comes before any write');
    } finally {
      store.close();
    }
  });

  it("runs on a host's own store handle that has the batched identity append", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-presentation-mandatory-'));
    dirs.push(dir);
    const store = JsStore.openOrCreate({ path: join(dir, 'store.chronicle') });
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
      framework.start();
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
      await framework.runUntilIdle();
      assert.equal(framework.getAgent('mira')!.getContextManager().windowMode(), 'presented');
      assert.ok((store.getStateLen('agents/mira/window') ?? 0) > 0, "mira's window is written down");
    } finally {
      await framework?.stop();
      store.close();
    }
  });

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
      // AF #844 bot review 4, finding 72: it needs no store, so it comes
      // before create() opens one.
      assert.ok(!existsSync(join(dir, 'store.chronicle')), 'no store was made');
    } finally {
      proto.presentRows = presentRows;
    }
  });

  it('loads on context-manager 0.24.0, which has no write-outcome errors, and create() names the release to install', () => {
    // A child process whose context-manager is 0.24.0's exports
    // (helpers/context-manager-0.24.ts). The package is ESM: a named import
    // of an export 0.25.0 added fails its load there, before create() runs.
    const dir = mkdtempSync(join(tmpdir(), 'af-presentation-mandatory-'));
    dirs.push(dir);
    const url = (path: string) => JSON.stringify(pathToFileURL(join(import.meta.dirname, path)).href);
    const script = `
      let outcome;
      try {
        const { AgentFramework } = await import(${url('../src/index.js')});
        const { MockMembrane } = await import(${url('helpers/mock-membrane.js')});
        try {
          await AgentFramework.create({
            storePath: ${JSON.stringify(join(dir, 'store.chronicle'))},
            membrane: new MockMembrane().asMembrane(),
            agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' }],
            modules: [],
          });
          outcome = { created: true };
        } catch (error) { outcome = { refused: error.message }; }
      } catch (error) { outcome = { load: String(error) }; }
      console.log(JSON.stringify(outcome));
      process.exit(0);
    `;
    const register = pathToFileURL(join(import.meta.dirname, 'helpers/context-manager-0.24-register.js')).href;
    const out = execFileSync(process.execPath, ['--import', register, '--input-type=module', '--eval', script], { encoding: 'utf8' });
    const outcome = JSON.parse(out.trim().split('\n').at(-1)!) as { load?: string; refused?: string; created?: true };
    assert.equal(outcome.load, undefined, `the package loads on 0.24.0: ${outcome.load}`);
    const declared = (JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    }).dependencies['@animalabs/context-manager']!;
    assert.ok(outcome.refused?.includes(`Install @animalabs/context-manager ${declared}, which this package declares`), JSON.stringify(outcome));
  });

  it('names no export context-manager 0.25.0 added in an import from it, in any module of src', () => {
    // Those come through src/context-manager-errors.ts, which reads them
    // from a namespace: the load test above runs what the package's index
    // loads, and this reads every module, an entry point's among them.
    const src = join(import.meta.dirname, '../../src');
    const named: string[] = [];
    for (const file of readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(src, file), 'utf8');
      // Either quote: no lint rule fixes the quotes an import is written with
      // (AF #844 bot review 3, finding 22).
      for (const m of text.matchAll(CONTEXT_MANAGER_IMPORT)) {
        if (m[1]) continue;
        for (const item of m[2]!.split(',').map((s) => s.trim())) {
          const name = item.split(/\s+as\s+/)[0]!;
          if (!item.startsWith('type ') && ADDED_IN_0_25.includes(name)) named.push(`${file}: ${name}`);
        }
      }
    }
    assert.deepEqual(named, []);
  });

  it('the scan reads an import from context-manager written with either quote', () => {
    const names = (text: string) => [...text.matchAll(CONTEXT_MANAGER_IMPORT)].map((m) => m[2]!.trim());
    assert.deepEqual(names(`import { WriteLandedError } from '@animalabs/context-manager';`), ['WriteLandedError']);
    assert.deepEqual(names(`import { WriteLandedError } from "@animalabs/context-manager";`), ['WriteLandedError']);
    assert.deepEqual(names(`export { WriteLandedError } from"@animalabs/context-manager"`), ['WriteLandedError']);
    assert.deepEqual(names(`import { X } from '@animalabs/context-manager-other';`), [], 'another package is not read');
  });
});

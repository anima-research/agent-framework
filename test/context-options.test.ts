/**
 * How a resident's context and the persistent subconscious's are opened
 * (#291, AF-5; context-options.ts): the framework opens its live agents with
 * residentContextOptions and subconsciousContextOptions, a host that opens
 * one of these contexts itself (an audit of the store) gets the same view
 * from them, and an ended agent's context is opened again with the view its
 * live one had. Until AF-5 a reopened resident's view left out held traffic
 * alone, and a reopened subconscious's nothing, so both compiled the other
 * residents' stored context injections, which their live views leave out.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ContextManager, PassthroughStrategy, WindowedPassthroughStrategy } from '@animalabs/context-manager';
import type { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';
import {
  AgentFramework, residentContextOptions, residentViewFilter, subconsciousContextOptions, subconsciousViewFilter,
} from '../src/index.js';
import type { AgentRecord, ContextManagerOpenOptions } from '../src/index.js';
import { STORED_INJECTION_KEY } from '../src/stored-injections.js';
import { persistentReaderName } from '../src/tune-out/tools.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
// A system change row compiles to no text, so it reads as a tag naming the
// tools it defines, and a compile that differs only in change rows differs here.
const textsOf = (messages: ReadonlyArray<{ content: ReadonlyArray<{ type: string; text?: string; defineTools?: ReadonlyArray<{ name: string }> }> }>) =>
  messages.map((m) => m.content.map((b) => (b.type === 'text' ? b.text ?? ''
    : b.type === 'system_change' ? `change:${(b.defineTools ?? []).map((t) => t.name).join(',')}` : '')).join('')).filter((t) => t !== '');

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
const opened: ContextManager[] = [];
afterEach(async () => {
  while (opened.length) { try { await opened.pop()!.close(); } catch { /* closed */ } }
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** mira and oren on the residents' slot, the subconscious serving mira, with a held row and oren's stored injection in the slot. */
async function boot(opts: { changes?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'context-options-'));
  dirs.push(dir);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: new MockMembrane().asMembrane(),
    agents: ['mira', 'oren'].map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.`, ...(opts.changes && name === 'oren' ? { toolDeclarations: 'entries' } : {}) })),
    subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'Read for mira.' },
    modules: [],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  } as never);
  frameworks.push(framework);
  const write = (framework as unknown as { addMessage(p: string, c: ContentBlock[], m?: Record<string, unknown>, o?: { forAgent?: string }): string }).addMessage
    .bind(framework);
  write('antra', [text('a word for both')]);
  write('antra', [text('a held word')], { tuneOut: { epochId: 'e1' } });
  // oren's stored context injection, as its own row in the shared slot.
  framework.getAgent('oren')!.getContextManager().addMessage('user', [text("oren's injected context")], {
    kind: 'context-injection',
    [STORED_INJECTION_KEY]: { agent: 'oren', namespace: 'notes', contentHash: 'h1', part: 0, parts: 1 },
  } as never);
  write('antra', [text('another word')]);
  if (opts.changes) {
    // A host's change row, and one each resident stamped as its own.
    const change = (tool: string) => [{ type: 'system_change', defineTools: [{ name: tool, description: tool, inputSchema: { type: 'object', properties: {} } }] } as unknown as ContentBlock];
    write('Host', change('host_tool'));
    for (const name of ['mira', 'oren']) write('system', change(`${name}_tool`), { system: true, kind: 'system-change', agent: name });
  }
  // The held row and oren's injection are 'elsewhere' for mira (and the
  // injection for the subconscious), so no presentation point takes them
  // in; a window written down from the record (an earlier release's) holds
  // them, though. Put every stored row in each window, as that one does, so
  // only the view keeps them out of a compile.
  for (const name of ['mira', 'oren', 'Subconscious']) {
    const cm = framework.getAgent(name)!.getContextManager();
    cm.presentRows(cm.getUnpresentedMessages().map((m) => m.id));
    assert.deepEqual(cm.getUnpresentedMessages(), [], `premise: ${name}'s window holds every stored row`);
  }
  const store = (framework as unknown as { store: JsStore }).store;
  const record = (name: string) => (framework as unknown as { registry: { inspect(n: string): AgentRecord | undefined } }).registry.inspect(name)!;
  const reopen = async (name: string) => {
    const cm = await (framework as unknown as { reopenAgentContext(r: AgentRecord, s?: unknown): Promise<ContextManager> })
      .reopenAgentContext(record(name), new PassthroughStrategy());
    opened.push(cm);
    return cm;
  };
  const open = async (options: ContextManagerOpenOptions) => {
    const cm = await ContextManager.open({ store, ...options });
    opened.push(cm);
    return cm;
  };
  // Dry, so the copies opened beside the live managers write nothing of theirs.
  const compiled = async (cm: ContextManager) => textsOf((await cm.compile(undefined, undefined, { dryRun: true } as never)).messages);
  const live = (name: string) => compiled(framework.getAgent(name)!.getContextManager());
  return { framework, reopen, open, compiled, live };
}

describe('the open shapes of a resident and the subconscious (#291, AF-5)', () => {
  it("a resident's view leaves out held traffic and another resident's stored injections; the subconscious's only the injections, and both a suppressed row", () => {
    const held = { metadata: { tuneOut: { epochId: 'e1' } } } as never;
    const orens = { metadata: { [STORED_INJECTION_KEY]: { agent: 'oren', namespace: 'n', contentHash: 'h', part: 0, parts: 1 } } } as never;
    const plain = { metadata: {} } as never;
    // AF #844 bot review 4, finding 91: a row a suppress rule took renders
    // for no reader.
    const suppressed = { metadata: { suppressed: { rule: 'r' } } } as never;
    assert.deepEqual([residentViewFilter('mira')(held), residentViewFilter('mira')(orens), residentViewFilter('mira')(plain), residentViewFilter('oren')(orens)],
      [false, false, true, true]);
    assert.deepEqual([subconsciousViewFilter('Subconscious')(held), subconsciousViewFilter('Subconscious')(orens), subconsciousViewFilter('Subconscious')(plain)],
      [true, false, true]);
    assert.deepEqual([residentViewFilter('mira')(suppressed), subconsciousViewFilter('Subconscious')(suppressed)], [false, false],
      "neither view keeps a suppressed row");
    const resident = residentContextOptions('mira');
    assert.equal(resident.namespace, 'agents/mira');
    assert.equal(resident.isolate, undefined, "the residents' shared slot");
    const sub = subconsciousContextOptions({ serves: 'mira', reAnchorFraction: 0.25 });
    assert.equal(sub.namespace, 'subconscious/mira');
    assert.equal(sub.isolate, true);
    assert.deepEqual(sub.auxiliaryMessageViews, [{}], "the residents' slot merged in: the record its window is presented from");
    assert.ok(sub.strategy instanceof WindowedPassthroughStrategy);
    assert.notEqual(subconsciousContextOptions({ serves: 'mira' }).strategy, sub.strategy, 'a strategy of its own each time');
  });

  // The audit of #291's mind-neutrality, D6: the export wrote the default
  // reader name a second time. The name is the configured reader's, which
  // the host passes; left out, it is the one the framework runs an unnamed
  // reader under, persistentReaderName's, not one this export chooses.
  it("names the view by the reader's configured name, and left out, by the name an unnamed reader runs under", () => {
    const injectionBy = (agent: string) => ({ metadata: { [STORED_INJECTION_KEY]: { agent, namespace: 'n', contentHash: 'h', part: 0, parts: 1 } } }) as never;
    const named = subconsciousContextOptions({ serves: 'mira', name: 'Muse' }).viewFilter!;
    assert.deepEqual([named(injectionBy('Muse')), named(injectionBy('Subconscious'))], [true, false],
      "the reader named Muse keeps its own injection and leaves out another agent's");
    const unnamed = subconsciousContextOptions({ serves: 'mira' }).viewFilter!;
    const runsUnder = persistentReaderName({});
    assert.deepEqual([unnamed(injectionBy(runsUnder)), unnamed(injectionBy('Muse'))], [true, false],
      'left out, the name is the one persistentReaderName gives an unnamed reader');
    assert.equal(persistentReaderName({ name: 'Muse' }), 'Muse');
  });

  // Presentation is mandatory since #291 (AF-6), so the case without the
  // presentation index this test once ran beside this one is gone.
  it("a host's open with the exported shapes compiles what the live agents compile", async () => {
    const h = await boot();
    const mira = await h.live('mira');
    assert.ok(mira.includes('a word for both') && !mira.includes('a held word') && !mira.includes("oren's injected context"), `premise: ${JSON.stringify(mira)}`);
    assert.deepEqual(await h.compiled(await h.open({ ...residentContextOptions('mira'), strategy: new PassthroughStrategy() })), mira, "mira's");
    const sub = await h.live('Subconscious');
    assert.ok(sub.includes('a held word') && !sub.includes("oren's injected context"), `premise: ${JSON.stringify(sub)}`);
    assert.deepEqual(await h.compiled(await h.open(subconsciousContextOptions({ serves: 'mira' }))), sub, "the subconscious's");
  });

  it("a host's open with the exported shapes compiles what the live agents compile with change rows in the store, on 'head' and under 'entries'", async () => {
    const h = await boot({ changes: true });
    const mira = await h.live('mira');
    assert.ok(mira.includes('a word for both') && !mira.some((t) => t.startsWith('change:')), `premise: mira, on 'head', compiles no change row: ${JSON.stringify(mira)}`);
    assert.deepEqual(await h.compiled(await h.open({ ...residentContextOptions('mira'), strategy: new PassthroughStrategy() })), mira, "mira's");
    const oren = await h.live('oren');
    assert.ok(oren.includes('change:host_tool') && oren.includes('change:oren_tool') && !oren.includes('change:mira_tool'), `premise: oren, under 'entries', compiles the host's change and its own, not mira's: ${JSON.stringify(oren)}`);
    assert.deepEqual(await h.compiled(await h.open({ ...residentContextOptions('oren', { toolDeclarations: 'entries' }), strategy: new PassthroughStrategy() })), oren, "oren's");
    const sub = await h.live('Subconscious');
    assert.ok(sub.includes('a held word') && !sub.some((t) => t.startsWith('change:')), `premise: the subconscious compiles no change row not its own: ${JSON.stringify(sub)}`);
    assert.deepEqual(await h.compiled(await h.open(subconsciousContextOptions({ serves: 'mira' }))), sub, "the subconscious's");
  });

  it("an inspection's reopen of a resident keeps a host's change rows and its own, which its compile on 'head' leaves out", async () => {
    const h = await boot({ changes: true });
    const live = await h.live('mira');
    assert.ok(!live.some((t) => t.startsWith('change:')), `premise: mira, on 'head', compiles no change row: ${JSON.stringify(live)}`);
    const reopened = await h.compiled(await h.reopen('mira'));
    assert.deepEqual(reopened.filter((t) => t.startsWith('change:')), ['change:host_tool', 'change:mira_tool'], "the host's change row and mira's own, not oren's");
    assert.deepEqual(reopened.filter((t) => !t.startsWith('change:')), live, 'and otherwise the view its live one had');
  });

  it("an ended agent's context reopens with the view its live one had", async () => {
    const h = await boot();
    // A reopen of the live agents' records, which is what an ended one's is.
    assert.deepEqual(await h.compiled(await h.reopen('mira')), await h.live('mira'), "a resident's: no other resident's stored injection");
    assert.deepEqual(await h.compiled(await h.reopen('oren')), await h.live('oren'), 'its own injection kept');
    assert.ok((await h.live('oren')).includes("oren's injected context"), 'premise: oren compiles its own injection');
    assert.deepEqual(await h.compiled(await h.reopen('Subconscious')), await h.live('Subconscious'), "the subconscious's: held traffic, and no resident's stored injection");
  });
});

/**
 * AF #844 bot review, finding 33: who a row is for, where the agents a
 * write names don't all read the slot it lands in.
 *
 * A module's process response whose `requestInference` names agents is
 * stamped for those of them that read the slot the write lands in (the
 * delivery agent's: the residents' slot on a residents' host); one naming
 * only agents that don't read it (an isolated job, a fork) is stamped as a
 * write that names no agent is, for the residents. On main every resident
 * read such a row; stamped for the fork alone, it reached no window. The
 * batched-wake line the gate writes (`gate:debounce`) follows the same rule.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageId } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, RESIDENTS_SLOT, audienceOf, sameSlot } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from './helpers/dendrite.js';

type Row = { id: MessageId; participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> };
const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const textOf = (row: { content: ContentBlock[] }) =>
  row.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)).join('');

/** A surface's module: an `external-message` event's text becomes a message, read by the agents its metadata names. */
class SurfaceModule implements Module {
  readonly name = 'surface';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const { content, metadata } = event as unknown as { content: ContentBlock[]; metadata: { ask: string[] } };
    return { addMessages: [{ participant: 'user', content }], requestInference: metadata.ask };
  }
}
const input = (t: string, ask: string[]): ProcessEvent =>
  ({ type: 'external-message', source: 'test', content: [text(t)], metadata: { ask } }) as unknown as ProcessEvent;

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-review8-audience-'));
  dirs.push(dir);
  return dir;
};

describe('a write naming agents is for those of them that read the slot it lands in (AF #844 finding 33)', () => {
  it('a response naming only an isolated job is for the residents; one naming a resident beside it is for that resident; so is the gate\'s line', async () => {
    const membrane = new RoutedMembrane();
    const gates = new GateModule();
    const framework = await AgentFramework.create({
      storePath: join(tempDir(), 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: ['mira', 'oren'].map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.` })),
      modules: [gates, new SurfaceModule()],
      // A gate whose default skips: the responses' wakes aren't the case here.
      gate: { onboarding: false, config: { policies: [], default: 'skip' } },
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
    frameworks.push(framework);
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => { traces.push(event); });
    framework.start();

    // An isolated job: a copy of mira on a slot of its own, blocked in a tool while the writes land.
    membrane.identify = (request) => (JSON.stringify(request.messages).includes('[WORKER-FRAMING]') ? 'worker-1' : request.assistantParticipant ?? '');
    membrane.script('worker-1', waitCall('g-worker'), say('worker done'));
    const worker = await framework.deriveAgent({
      name: 'worker-1', from: 'mira', mode: 'copy',
      framing: [{ participant: 'user', content: [text('[WORKER-FRAMING] count them')] }],
    });
    const run = framework.runEphemeralToCompletion(worker.agent, worker.contextManager);
    await until(() => gates.entered.has('g-worker'), 'the worker to block in its tool');
    const workerSlot = framework.getAgentRecord('worker-1')!.ownSlot;
    assert.ok(workerSlot && !sameSlot(workerSlot, RESIDENTS_SLOT), "setup: the worker doesn't read the residents' slot");

    const cm = (name: string) => framework.getAgent(name)!.getContextManager();
    const rowNamed = (t: string) => (cm('mira').getAllMessages() as unknown as Row[]).find((r) => textOf(r) === t);
    const inWindow = (name: string, t: string) => cm(name).ordinalOf(rowNamed(t)!.id) !== undefined;

    framework.pushEvent(input('ASKS-THE-WORKER', ['worker-1']));
    framework.pushEvent(input('ASKS-THE-WORKER-AND-OREN', ['worker-1', 'oren']));
    framework.pushEvent(input('ASKS-OREN', ['oren']));
    await until(() => ['ASKS-THE-WORKER', 'ASKS-THE-WORKER-AND-OREN', 'ASKS-OREN'].every((t) => rowNamed(t) !== undefined), 'the three rows to be stored');

    // The gate's batched line, for a group of agents the gate woke.
    const gate = (framework as unknown as {
      eventGate: { addMessageFn(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, forAgent?: string, placement?: unknown, audience?: readonly string[]): unknown };
    }).eventGate;
    gate.addMessageFn('user', [text('GATE-LINE-FOR-THE-WORKER')], { source: 'gate:debounce', policies: ['p'] }, undefined, undefined, ['worker-1']);
    gate.addMessageFn('user', [text('GATE-LINE-FOR-THE-WORKER-AND-OREN')], { source: 'gate:debounce', policies: ['p'] }, undefined, undefined, ['worker-1', 'oren']);

    const audience = (t: string) => {
      const row = rowNamed(t);
      assert.ok(row, `${t} is stored in the residents' slot`);
      return audienceOf(row.metadata)?.audience;
    };
    assert.deepEqual(audience('ASKS-THE-WORKER'), ['mira', 'oren'], 'naming only the worker: for the residents, as a write that names no agent');
    assert.deepEqual(audience('ASKS-THE-WORKER-AND-OREN'), ['oren'], 'for the one it names that reads the slot');
    assert.deepEqual(audience('ASKS-OREN'), ['oren'], 'naming one resident: for that resident only');
    assert.deepEqual(audience('GATE-LINE-FOR-THE-WORKER'), ['mira', 'oren'], "the gate's line for the worker alone: for the residents");
    assert.deepEqual(audience('GATE-LINE-FOR-THE-WORKER-AND-OREN'), ['oren'], "the gate's line for the worker and oren: for oren");

    for (const t of ['ASKS-THE-WORKER', 'GATE-LINE-FOR-THE-WORKER']) {
      assert.deepEqual([inWindow('mira', t), inWindow('oren', t)], [true, true], `${t} reaches both residents' windows`);
    }
    for (const t of ['ASKS-THE-WORKER-AND-OREN', 'ASKS-OREN', 'GATE-LINE-FOR-THE-WORKER-AND-OREN']) {
      assert.deepEqual([inWindow('mira', t), inWindow('oren', t)], [false, true], `${t} reaches oren's window alone`);
    }
    assert.deepEqual(traces.filter((e) => e.type === 'presentation:unreadable-audience'), [], 'no stamp names only agents that cannot read its slot');

    gates.release('g-worker');
    await run;
  });
});

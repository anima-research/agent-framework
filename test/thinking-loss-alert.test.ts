/**
 * The operators' alert for thinking the provider dropped that the context manager's binding record says the
 * request carried intact. A reply stored at or below the record's start (`thinkingRecordedAfter`) may lose its
 * thinking with no strip having missed; any other drop alerts, once per incident, again only when a call shows
 * more, and the incident ends at a report that shows none. Without a record start, nothing alerts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DetailedUsage, NormalizedRequest, NormalizedResponse, ThinkingBindingEntry, YieldingStream } from '@animalabs/membrane';

import { AgentFramework } from '../src/index.js';
import type { Module, ToolCall, TraceEvent } from '../src/index.js';
import { splitThinkingDrops, ThinkingLossIncidents, type PlacedDrop } from '../src/thinking-drops.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

const entry = (fields: Partial<ThinkingBindingEntry> = {}): ThinkingBindingEntry =>
  ({ reason: 'prefix_binding_mismatch', path: 'messages.0.content.0', ...fields });
const reply = (...sequences: number[]): PlacedDrop =>
  ({ kind: 'reply', bodies: sequences.map((sequence, i) => ({ messageId: `m${sequence}-${i}`, sequence })), entry: entry() });

describe('splitThinkingDrops', () => {
  it('expects a drop only in a reply stored at or below the record\'s start, every shard of it', () => {
    const round: PlacedDrop = { kind: 'round', round: 1, entry: entry() };
    const unplaced: PlacedDrop = { kind: 'unplaced', entry: entry() };
    const { expected, unexpected } = splitThinkingDrops([reply(3), reply(5), reply(6), reply(5, 6), round, unplaced], 5);
    assert.deepEqual(expected, [reply(3), reply(5)], 'below, and at, the start');
    assert.deepEqual(unexpected, [reply(6), reply(5, 6), round, unplaced], 'above it, a reply one of whose shards is above it, a round, and unplaced');
  });
});

describe('ThinkingLossIncidents', () => {
  it('alerts at an incident\'s first call, again only when a call shows more, and afresh after a call shows none', () => {
    const incidents = new ThinkingLossIncidents();
    assert.deepEqual([2, 2, 1, 3, 3, 0, 0, 1].map((n) => incidents.observe('a', n)),
      [2, undefined, undefined, 3, undefined, undefined, undefined, 1]);
    assert.equal(incidents.observe('b', 3), 3, 'each agent\'s incidents are its own');
    assert.equal(incidents.observe('a', 1), undefined, 'a\'s incident still open');
  });
});

const SIG = 'sig-earlier'.repeat(12);
const usage = (input: number): DetailedUsage => ({ inputTokens: input, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 });

/** Answers each stream with the responses `script` builds from the request: where the stored reply's signed block
 *  sits in it, which a dropped entry names. */
class ScriptedMembrane extends MockMembrane {
  constructor(private readonly script: (at: { message: number; block: number }) => NormalizedResponse[]) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    let at = { message: -1, block: -1 };
    request.messages.forEach((m, message) => m.content.forEach((b, block) => {
      if ((b as { signature?: unknown }).signature === SIG) at = { message, block };
    }));
    assert.ok(at.message >= 0, 'the request carries the stored reply\'s signed block');
    const stream = new MockYieldingStream(this.script(at));
    this.lastStream = stream;
    return stream;
  }
}
class Tools implements Module {
  readonly name = 'test';
  async start() {}
  async stop() {}
  async onProcess() { return {}; }
  getTools() { return [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' as const, properties: {} } }]; }
  async handleToolCall(_call: ToolCall) { return { success: true, data: {} }; }
}
const withThinking = (response: NormalizedResponse, input: number, dropped: ThinkingBindingEntry[]): NormalizedResponse =>
  Object.assign(response, { usage: usage(input), round: { thinking: { dropped, mismatchAllowed: [] } } });
const toolRound = (input: number, dropped: ThinkingBindingEntry[], id: string) =>
  withThinking(createMockResponse([{ type: 'tool_use', name: 'test--echo', id, input: {} }], 'tool_use'), input, dropped);
const final = (input: number, dropped: ThinkingBindingEntry[]) => {
  const response = withThinking(createMockResponse([{ type: 'text', text: 'Done.' }]), input, dropped);
  response.details!.usage = response.usage;
  return response;
};

/** One turn of an agent whose stored earlier reply carries a signed block, with the compile's record start set
 *  `relative` to that reply's sequence (or left out), and the stream's calls dropping it as `drops` says. */
async function turn(relative: number | undefined, drops: (at: { message: number; block: number }) => ThinkingBindingEntry[][]) {
  const dir = mkdtempSync(join(tmpdir(), 'af-thinking-loss-'));
  const membrane = new ScriptedMembrane((at) => {
    const [first = [], second = [], third = []] = drops(at);
    return [toolRound(100, first, 'c1'), toolRound(110, second, 'c2'), final(120, third)];
  });
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(), agents: [], modules: [new Tools()], syncIntervalMs: 0,
  });
  const alerts: TraceEvent[] = [];
  framework.onTrace((event) => { if (event.type === 'ops:alert' && (event as { kind?: string }).kind === 'thinking-binding-loss') alerts.push(event); });
  framework.start();
  try {
    const { agent, contextManager } = await framework.createEphemeralAgent({
      name: 'worker', model: 'claude-opus-5-5', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'disabled',
      thinking: { enabled: true, budgetTokens: 1024 }, thinkingBinding: { binds: true, dropBlock: true },
    } as never);
    contextManager.addMessage('user', [{ type: 'text', text: 'Earlier.' }]);
    contextManager.addMessage('worker', [{ type: 'thinking', thinking: '', signature: SIG } as never, { type: 'text', text: 'Earlier reply.' }]);
    contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
    const compile = contextManager.compile.bind(contextManager);
    contextManager.compile = (async (...args: Parameters<typeof compile>) => {
      const result = await compile(...args);
      if (relative === undefined) return result;
      const at = result.messages.findIndex((m) => m.content.some((b) => (b as { signature?: unknown }).signature === SIG));
      const source = result.provenance?.messages[at];
      assert.ok(source?.kind === 'raw', 'the compile names the stored reply');
      return { ...result, thinkingRecordedAfter: source.bodies[0]!.sequence + relative };
    }) as typeof compile;
    await framework.runEphemeralToCompletion(agent, contextManager);
    assert.equal(membrane.calls.length, 1, 'one stream');
    return alerts as Array<TraceEvent & { message: string; data?: Record<string, unknown> }>;
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the operators\' alert on a framework turn', () => {
  const dropped = (at: { message: number; block: number }) => entry({ message: at.message, block: at.block });

  it('alerts once for a reply above the record\'s start that every call of the stream drops', async () => {
    const alerts = await turn(-1, (at) => [[dropped(at)], [dropped(at)], [dropped(at)]]);
    assert.equal(alerts.length, 1, 'the same count again isn\'t news');
    assert.match(alerts[0]!.message, /dropped 1 signed thinking block that the context manager's binding record says the request carried intact/);
    assert.equal(alerts[0]!.data?.blocks, 1);
  });

  it('alerts afresh after a call whose report shows none', async () => {
    const alerts = await turn(-1, (at) => [[dropped(at)], [], [dropped(at)]]);
    assert.equal(alerts.length, 2);
  });

  it('stays quiet for a reply at the record\'s start, and where the compile gives no record start', async () => {
    assert.equal((await turn(0, (at) => [[dropped(at)], [dropped(at)], []])).length, 0, 'minted before the record began');
    assert.equal((await turn(undefined, (at) => [[dropped(at)], [dropped(at)], []])).length, 0, 'a context manager without a record');
  });
});

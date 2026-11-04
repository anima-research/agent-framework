/**
 * The operators' alert for thinking the provider dropped that the context manager's binding record doesn't account
 * for. A reply stored at or below the record's start (`thinkingRecordedAfter`) may lose its thinking with no strip
 * having missed, and so may a block for a binding the record doesn't track (the account's); any other drop alerts,
 * once per incident, again only when a call shows more, and the incident ends at a call that shows no unexpected drop,
 * its report empty, absent or naming only expected ones. Without a record start, nothing alerts.
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
  it('expects a drop in a reply stored at or below the record\'s start, every body of it, and no other of a binding the record tracks', () => {
    const round: PlacedDrop = { kind: 'round', round: 1, entry: entry() };
    const unplaced: PlacedDrop = { kind: 'unplaced', entry: entry() };
    const { expected, unexpected } = splitThinkingDrops([reply(3), reply(5), reply(6), reply(5, 6), round, unplaced], 5);
    assert.deepEqual(expected, [reply(3), reply(5)], 'below, and at, the start');
    assert.deepEqual(unexpected, [reply(6), reply(5, 6), round, unplaced], 'above it, a reply one of whose bodies is above it, a round, and unplaced');
  });

  it('expects a drop for a binding the record doesn\'t track, the account\'s, wherever it sits', () => {
    const org: PlacedDrop = { kind: 'reply', bodies: [{ messageId: 'm9', sequence: 9 }], entry: entry({ reason: 'organization_binding_mismatch' }) };
    const user: PlacedDrop = { kind: 'unplaced', entry: entry({ reason: 'end_user_binding_mismatch' }) };
    const model: PlacedDrop = { kind: 'reply', bodies: [{ messageId: 'm9', sequence: 9 }], entry: entry({ reason: 'model_binding_mismatch' }) };
    const { expected, unexpected } = splitThinkingDrops([org, user, model], 5);
    assert.deepEqual(expected, [org, user]);
    assert.deepEqual(unexpected, [model], 'a model mismatch the record\'s model digest didn\'t show');
  });
});

describe('ThinkingLossIncidents', () => {
  it('alerts at an incident\'s first call, again only when a call shows more, and afresh after a call shows none', () => {
    const incidents = new ThinkingLossIncidents();
    assert.deepEqual([2, 2, 1, 3, 3, 0, 0, 1].map((n) => incidents.observe('a', n)),
      [2, undefined, undefined, 3, undefined, undefined, undefined, 1]);
    assert.equal(incidents.observe('b', 3), 3, 'each agent\'s incidents are its own');
    assert.equal(incidents.observe('a', 1), undefined, 'a\'s incident still open');
    incidents.forget('a');
    assert.equal(incidents.observe('a', 1), 1, 'a removed agent\'s incident ends with it');
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
/** A call's response, with a thinking report of `dropped`, or none where it's null. */
const withThinking = (response: NormalizedResponse, input: number, dropped: ThinkingBindingEntry[] | null): NormalizedResponse =>
  Object.assign(response, { usage: usage(input), ...(dropped ? { round: { thinking: { dropped, mismatchAllowed: [] } } } : {}) });
const toolRound = (input: number, dropped: ThinkingBindingEntry[] | null, id: string) =>
  withThinking(createMockResponse([{ type: 'tool_use', name: 'test--echo', id, input: {} }], 'tool_use'), input, dropped);
const final = (input: number, dropped: ThinkingBindingEntry[] | null) => {
  const response = withThinking(createMockResponse([{ type: 'text', text: 'Done.' }]), input, dropped);
  response.details!.usage = response.usage;
  return response;
};

/** One turn of an agent whose stored earlier reply carries a signed block, with the compile's record start set
 *  `relative` to that reply's sequence (or left out), and the stream's calls dropping it as `drops` says; `after`
 *  looks at the framework once the run has ended. */
async function turn(
  relative: number | undefined, drops: (at: { message: number; block: number }) => Array<ThinkingBindingEntry[] | null>,
  after?: (framework: AgentFramework) => void,
) {
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
      // No record start: a compile that gives none, as before a branch's record is written.
      if (relative === undefined) return { ...result, thinkingRecordedAfter: undefined };
      const at = result.messages.findIndex((m) => m.content.some((b) => (b as { signature?: unknown }).signature === SIG));
      const source = result.provenance?.messages[at];
      assert.ok(source?.kind === 'raw', 'the compile names the stored reply');
      return { ...result, thinkingRecordedAfter: source.bodies[0]!.sequence + relative };
    }) as typeof compile;
    await framework.runEphemeralToCompletion(agent, contextManager);
    after?.(framework);
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
    assert.match(alerts[0]!.message, /dropped 1 signed thinking block that the context manager's binding record doesn't account for/);
    assert.match(alerts[0]!.message, /It clears at a call that drops none of those/);
    assert.equal(alerts[0]!.data?.blocks, 1);
  });

  it('alerts afresh after a call whose report shows none', async () => {
    const alerts = await turn(-1, (at) => [[dropped(at)], [], [dropped(at)]]);
    assert.equal(alerts.length, 2);
  });

  it('leaves no incident behind for a run\'s agent, which the run\'s end removes', async () => {
    const open: boolean[] = [];
    const alerts = await turn(-1, (at) => [[dropped(at)], [dropped(at)], [dropped(at)]], (framework) => {
      const incidents = (framework as unknown as { thinkingLossIncidents: { alerted: Map<string, number> } }).thinkingLossIncidents;
      open.push(incidents.alerted.has('worker'));
    });
    assert.equal(alerts.length, 1);
    assert.deepEqual(open, [false], 'the agent\'s per-name state goes with it, its incident included');
  });

  it('alerts afresh after a call with no report at all', async () => {
    const alerts = await turn(-1, (at) => [[dropped(at)], null, [dropped(at)]]);
    assert.equal(alerts.length, 2);
  });

  it('counts a block of the stream\'s own round and one it can\'t place, and names each in the alert\'s data', async () => {
    // The second call drops round 0's block (the stream's own first reply) and a block at the request's first
    // message, which holds no signed block, so it can't be placed; the stored reply, at the record's start, is kept.
    const alerts = await turn(0, () => [[], [entry({ message: 3, block: 0, round: 0 }), entry({ message: 0, block: 0 })], []]);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.message, /dropped 2 signed thinking blocks/);
    assert.match(alerts[0]!.message, /0 in stored replies after the record began at sequence \d+, 1 from the stream's own rounds, 1 that couldn't be placed/);
    assert.deepEqual({ replies: alerts[0]!.data?.replies, rounds: alerts[0]!.data?.rounds, unplaced: alerts[0]!.data?.unplaced },
      { replies: [], rounds: [0], unplaced: 1 });
  });

  it('stays quiet for a drop for the account\'s binding, wherever it sits', async () => {
    // At the stored reply, above the record's start; at the stream's own round; and where it can't be placed: each
    // would alert for a conversation's mismatch (the tests above).
    const account = (fields: Partial<ThinkingBindingEntry>, reason: string) => entry({ ...fields, reason } as never);
    const alerts = await turn(-1, (at) => [
      [account(at, 'organization_binding_mismatch')],
      [account({ message: 3, block: 0, round: 0 }, 'end_user_binding_mismatch'), account({ message: 0, block: 0 }, 'organization_binding_mismatch')],
      [],
    ]);
    assert.equal(alerts.length, 0, 'the record tracks neither');
  });

  it('ends a conversation agent\'s incident when the agent is disposed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-thinking-loss-dispose-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: new MockMembrane().asMembrane(), agents: [], modules: [], syncIntervalMs: 0,
    });
    try {
      await framework.createEphemeralAgent({ name: 'fork', model: 'claude-opus-5-5', systemPrompt: 'Fork.', allowedTools: 'all', proseRouting: 'disabled' } as never);
      const internal = framework as unknown as {
        thinkingLossIncidents: { observe(agent: string, count: number): unknown; alerted: Map<string, number> };
        disposeConversationAgent(name: string): void;
      };
      internal.thinkingLossIncidents.observe('fork', 2);
      assert.ok(internal.thinkingLossIncidents.alerted.has('fork'), 'an open incident');
      internal.disposeConversationAgent('fork');
      assert.equal(internal.thinkingLossIncidents.alerted.has('fork'), false);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays quiet for a reply at the record\'s start, and where the compile gives no record start', async () => {
    assert.equal((await turn(0, (at) => [[dropped(at)], [dropped(at)], []])).length, 0, 'minted before the record began');
    assert.equal((await turn(undefined, (at) => [[dropped(at)], [dropped(at)], []])).length, 0, 'a compile that gives no record start');
  });
});

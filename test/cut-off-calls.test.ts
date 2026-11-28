import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicAdapter, AnthropicXmlFormatter, Membrane } from '@animalabs/membrane';

import { AgentFramework } from '../src/index.js';
import { TOOL_RESULT_GUARD_AUDIT_STATE } from '../src/tool-result-guard.js';
import { draftState, type Draft } from '../src/prose-drafts.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';

type Block = { text: string } | { thinking: string } | { call: string; json: string[]; whole: boolean };
type Reply = { blocks: Block[]; stop: 'max_tokens' | 'tool_use' | 'end_turn' } | { xml: string; stop: 'max_tokens' | 'stop_sequence' | 'end_turn' };

const NEXT = 'The next answer.';
const RAN_NOT = "didn't run, because the response it was in was cut off at the output limit";
const ADVICE = 'send less in one response';
const UNNAMED = '[tool-boundary] Your response was cut off at the output limit inside a tool-call block, before any call in it was named, so nothing ran.';

function sse(reply: Reply): string {
  const out: string[] = [];
  const event = (type: string, data: Record<string, unknown>) => out.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  const blocks: Block[] = 'xml' in reply ? [{ text: reply.xml }] : reply.blocks;
  blocks.forEach((block, index) => {
    if ('thinking' in block) {
      event('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
      event('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      event('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'sig-test' } });
      event('content_block_stop', { index });
    } else if ('text' in block) {
      event('content_block_start', { index, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
      if (!('xml' in reply) || reply.stop !== 'max_tokens') event('content_block_stop', { index });
    } else {
      event('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${index}_${Math.random().toString(36).slice(2)}`, name: block.call, input: {} } });
      for (const part of block.json) event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: part } });
      if (block.whole) event('content_block_stop', { index });
    }
  });
  const stopSequence = 'xml' in reply && reply.stop === 'stop_sequence' ? '</function_calls>' : null;
  event('message_delta', { delta: { stop_reason: reply.stop, stop_sequence: stopSequence }, usage: { output_tokens: 20 } });
  event('message_stop', {});
  return out.join('');
}

class Robot implements Module {
  readonly name = 'robot';
  readonly moves: unknown[] = [];
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [
      { name: 'move', description: 'Move the robot', inputSchema: { type: 'object', properties: { dir: { type: 'string' } } } },
      { name: 'send_message', description: 'Send a message', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.moves.push(call.input);
    return { success: true, data: { moved: (call.input as { dir?: string }).dir } };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const text = String((event as { content?: unknown }).content);
    return { addMessages: [{ participant: 'Antra', content: [{ type: 'text', text }] }], requestInference: true };
  }
}

interface Run {
  mode: 'native' | 'xml';
  moves: unknown[];
  skipReplies: number;
  routed: string[];
  /** Each posted text with the channel it went to. */
  routedTo: Array<[string, string]>;
  rows: Array<{ participant: string; content: Array<Record<string, any>> }>;
  requests: string[];
  boundaryLines: string[];
  failedTraces: Array<{ callId?: string; tool?: string; error?: string }>;
  audit: Array<Record<string, any>>;
  drafts: Array<{ text: string; reason: string }>;
  /** The drafts the run held and didn't deliver, with their ids and notes. */
  held: Array<{ id: string; text: string; reason: string; note?: string }>;
}

/** What a turn's harness adds beside the agent's settings: framework config, modules, a first wake that is a heartbeat, labels the stand-in registry resolves, and the channel tools it offers (a script sees only those). */
type TurnOptions = { framework?: Record<string, unknown>; modules?: Module[]; heartbeat?: boolean; resolves?: Record<string, string>; channelTools?: ToolDefinition[] };

async function turn(mode: 'native' | 'xml', replies: Reply[], settings: Record<string, unknown> = {}, opts: TurnOptions = {}): Promise<Run> {
  const requests: string[] = [];
  const queue = [...replies];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (String(req.url).includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      requests.push(raw);
      const reply = queue.shift() ?? (mode === 'xml' ? { xml: NEXT, stop: 'end_turn' as const } : { blocks: [{ text: NEXT }], stop: 'end_turn' as const });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const adapter = new AnthropicAdapter({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, cacheKeepalive: { enabled: false } } as never);
  const membrane = mode === 'xml' ? new Membrane(adapter, { formatter: new AnthropicXmlFormatter({ toolMode: 'xml' }) }) : new Membrane(adapter);
  const dir = mkdtempSync(join(tmpdir(), 'af-cut-off-'));
  const robot = new Robot();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane,
    agents: [{ name: 'resident', model: mode === 'xml' ? 'claude-opus-4-1' : 'claude-opus-5-5', systemPrompt: 'You are a resident.', sendSilencing: true, proseRouting: 'locus', ...settings } as never],
    modules: [robot, ...(opts.modules ?? [])],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
    ...opts.framework,
  });
  const routed: string[] = [];
  const routedTo: Array<[string, string]> = [];
  let skipReplies = 0;
  const deliver = async (_agent: string, text: string, locus?: { channelId: string } | null) => {
    routed.push(text);
    routedTo.push([locus?.channelId ?? 'world:commons', text]);
    return { status: 'delivered' as const, destination: { serverId: 'stub', channelId: locus?.channelId ?? 'world:commons' }, at: Date.now() };
  };
  const registry: Record<string, unknown> = {
    deliverSpeech: deliver,
    routeSpeech: async (agent: string, text: string, locus?: { channelId: string } | null) => {
      await deliver(agent, text, locus);
      return { delivered: true, serverId: 'stub', channelId: locus?.channelId ?? 'world:commons' };
    },
    resolveProseTarget: (spec: string) => (opts.resolves?.[spec]
      ? { serverId: 'stub', channelId: opts.resolves[spec] }
      : { error: `no channel matches "${spec}"` }),
    resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: 'stub', channelId } }),
    resolveLocus: () => ({ serverId: 'stub', channelId: 'world:commons' }),
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => opts.channelTools ?? [],
    channelsNamed: (name: string) => [{ serverId: 'stub', channelId: name }],
    nameShown: (channel: { channelId: string }) => channel.channelId,
    handleChannelToolCall: async () => {
      skipReplies++;
      return { success: true, endTurn: true, data: { skipped: true } };
    },
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(registry, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  const failedTraces: Run['failedTraces'] = [];
  framework.onTrace((event) => {
    if (event.type === 'tool:failed') failedTraces.push(event as Run['failedTraces'][number]);
  });
  const lines: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    framework.start();
    if (opts.heartbeat) {
      (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: 'resident', timestamp: Date.now(), reason: 'heartbeat', source: 'heartbeat' });
    } else {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
    }
    await framework.runUntilIdle();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'And next?', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    const cm = framework.getAgent('resident')!.getContextManager() as unknown as { getAllMessages(): Run['rows'] };
    // Every draft the run held and didn't deliver, newest first, open or not:
    // the "And next?" turn leaves the first turn's drafts alone, which sets
    // them aside at its end.
    const undelivered = [...((framework as unknown as { proseDrafts: { drafts: Map<string, Map<string, Draft>> } }).proseDrafts.drafts.get('resident')?.values() ?? [])]
      .filter((d) => draftState(d) !== 'delivered').reverse();
    return {
      mode,
      moves: robot.moves,
      skipReplies,
      routed: [...routed],
      routedTo: [...routedTo],
      rows: cm.getAllMessages(),
      requests,
      boundaryLines: lines.filter((line) => line.startsWith('[tool-boundary]')),
      failedTraces,
      audit: settings.toolResultGuard ? framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, any>> : [],
      drafts: undelivered.map((d) => ({ text: d.text, reason: d.reason })),
      held: undelivered.map((d) => ({ id: d.id, text: d.text, reason: d.reason, ...(d.note ? { note: d.note } : {}) })),
    };
  } finally {
    console.error = error;
    await framework.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

const blocks = (run: Run, type: string) => run.rows.flatMap((row) => row.content.filter((block) => block.type === type));
const toolResultText = (block: Record<string, any>) => JSON.stringify(block.content);
const replyTexts = (run: Run) => run.rows.filter((row) => row.participant === 'resident')
  .flatMap((row) => row.content.filter((block) => block.type === 'text').map((block) => block.text as string));

function assertRefusedPair(run: Run, calls: Array<{ name: string; says: string }>): void {
  const refusals = blocks(run, 'tool_result').filter((block) => toolResultText(block).includes('Nothing was done'));
  assert.equal(refusals.length, calls.length, 'one refused result for each call of the round, and none for a call that ran');
  const unmatched = [...refusals];
  const next = run.requests[run.requests.length - 1];
  const occurrences = (text: string) => next.split(text).length - 1;
  for (const { name, says } of calls) {
    const refusal = `Nothing was done: ${name} ${says}`;
    const result = unmatched.find((block) => toolResultText(block).includes(refusal));
    assert.ok(result, `a result says: ${refusal}`);
    unmatched.splice(unmatched.indexOf(result), 1);
    assert.equal(result.isError, true);
    assert.ok(toolResultText(result).includes(ADVICE), 'and says what to do instead');
    const useRow = run.rows.findIndex((row) => row.content.some((block) => block.type === 'tool_use' && block.id === result.toolUseId));
    const resultRow = run.rows.findIndex((row) => row.content.includes(result));
    assert.equal(run.rows[useRow]?.content.find((block) => block.id === result.toolUseId)?.name, name, 'the reply stores the call it answers');
    assert.equal(resultRow, useRow + 1, 'its result is stored right after the reply');
    if (run.mode === 'native') {
      assert.ok(next.includes(`"id":"${result.toolUseId}"`), 'the next request carries the call');
      assert.ok(next.includes(`"tool_use_id":"${result.toolUseId}"`), 'and its result');
    }
    const traced = run.failedTraces.filter((trace) => trace.callId === result.toolUseId);
    assert.equal(traced.length, 1, 'one tool:failed trace for the call');
    assert.equal(traced[0]!.tool, name);
    assert.ok(traced[0]!.error?.includes(refusal), 'naming its refusal');
  }
  for (const { name, says } of calls) {
    const refusal = `Nothing was done: ${name} ${says}`;
    const expected = calls.filter((call) => call.name === name && call.says === says).length;
    assert.ok(occurrences(refusal) >= expected, `the next request carries each refusal: ${refusal}`);
    if (run.mode === 'xml') {
      const stored = run.rows.flatMap((row) => row.content).filter((block) => block.type === 'tool_use' && block.name === name).length;
      assert.ok(stored >= calls.filter((call) => call.name === name).length);
      assert.ok(occurrences(`invoke name=\\"${name}\\"`) >= stored, 'with each stored call of that name, an earlier round\'s included');
    }
  }
  assert.equal(new Set(refusals.map((block) => block.toolUseId)).size, refusals.length, 'each answers a call of its own');
}

const EAST_ROUND: Reply = { blocks: [{ text: 'First I step east.' }, { call: 'robot--move', json: ['{"dir": "east"}'], whole: true }], stop: 'tool_use' };
const XML_EAST_ROUND: Reply = { xml: 'First I step east.\n\n<function_calls>\n<invoke name="robot--move">\n<parameter name="dir">east</parameter>\n</invoke>\n', stop: 'stop_sequence' };
const noBlockText = (run: Run) => replyTexts(run).every((text) => !/<(antml:)?(function_calls|invoke|parameter)/.test(text));
const receipts = (run: Run) => {
  const next = run.rows.findIndex((row) => row.content.some((block) => block.text === 'And next?'));
  return run.rows.slice(0, next).filter((row) => row.participant !== 'resident').flatMap((row) => row.content)
    .map((block) => String(block.text ?? '')).filter((text) => text.startsWith('[delivered]'));
};
const THINK_CUT: Reply = { blocks: [{ text: 'Musing to myself.' }, { call: 'think', json: ['{"thought": "is it'], whole: false }], stop: 'max_tokens' };

describe('native tools: a response that ends at the output limit with calls in its last round', () => {
  for (const [label, json] of [['partway through its arguments', ['{"dir": "no']], ['before any argument', []]] as const) {
    it(`stores a call cut off ${label} with a refused result, runs nothing, and publishes the round's words`, async () => {
      const run = await turn('native', [{ blocks: [{ text: 'Heading north now, to the gate.' }, { call: 'robot--move', json: [...json], whole: false }], stop: 'max_tokens' }]);
      assert.deepEqual(run.moves, []);
      assertRefusedPair(run, [{ name: 'robot--move', says: RAN_NOT }]);
      assert.ok(replyTexts(run).includes('Heading north now, to the gate.'), 'the agent can read what it said');
      assert.deepEqual(run.routed, ['Heading north now, to the gate.', NEXT]);
      assert.equal(run.requests.length, 2, 'one request for the cut-off turn and one for the next');
      assert.equal(run.boundaryLines.length, 1);
      assert.match(run.boundaryLines[0], /max_tokens inside 1 call\(s\) \(robot--move\)/);
    });
  }

  it('keeps the round\'s thinking with its call', async () => {
    const run = await turn('native', [{ blocks: [{ thinking: 'North, then the gate.' }, { text: 'Heading north now.' }, { call: 'robot--move', json: ['{"dir": "no'], whole: false }], stop: 'max_tokens' }]);
    assertRefusedPair(run, [{ name: 'robot--move', says: RAN_NOT }]);
    const reply = run.rows.find((row) => row.content.some((block) => block.type === 'tool_use'))!;
    assert.deepEqual(reply.content.map((block) => block.type), ['thinking', 'text', 'tool_use']);
    assert.equal(reply.content[0].thinking, 'North, then the gate.');
    assert.equal(reply.content[0].signature, 'sig-test');
    assert.equal(run.requests.length, 2);
  });

  it('stores the last round of a turn whose earlier round ran, and publishes both rounds\' words', async () => {
    const run = await turn('native', [
      EAST_ROUND,
      { blocks: [{ text: 'Now heading north to the gate.' }, { call: 'robot--move', json: ['{"dir": "no'], whole: false }], stop: 'max_tokens' },
    ]);
    assert.deepEqual(run.moves, [{ dir: 'east' }]);
    assertRefusedPair(run, [{ name: 'robot--move', says: RAN_NOT }]);
    assert.ok(replyTexts(run).includes('Now heading north to the gate.'));
    assert.deepEqual(run.routed, ['First I step east.', 'Now heading north to the gate.', NEXT]);
    assert.equal(run.requests.length, 3);
  });

  it('keeps a cut-off skip_reply\'s round private, and runs nothing', async () => {
    const run = await turn('native', [{ blocks: [{ text: 'A note to myself, not for the room.' }, { call: 'skip_reply', json: ['{"wake_in_sec'], whole: false }], stop: 'max_tokens' }]);
    assert.equal(run.skipReplies, 0);
    assertRefusedPair(run, [{ name: 'skip_reply', says: RAN_NOT }]);
    assert.ok(replyTexts(run).includes('A note to myself, not for the room.'));
    assert.deepEqual(run.routed, [NEXT]);
    assert.equal(run.requests.length, 2);
  });

  it("under sameRoundSkipReplyTextPolicy 'ask', holds a cut-off skip_reply's round as a draft, and runs nothing", async () => {
    const run = await turn('native', [{ blocks: [{ text: 'A note for the room.' }, { call: 'skip_reply', json: ['{"wake_in_sec'], whole: false }], stop: 'max_tokens' }], { sameRoundSkipReplyTextPolicy: 'ask' });
    assert.equal(run.skipReplies, 0);
    assertRefusedPair(run, [{ name: 'skip_reply', says: RAN_NOT }]);
    assert.deepEqual(run.routed, [NEXT]);
    const texts = run.rows.flatMap((row) => row.content.filter((block) => block.type === 'text').map((block) => block.text as string));
    assert.ok(texts.some((t) => t.startsWith('[delivered]') && /held as drafts? d-/.test(t)), texts.filter((t) => t.startsWith('[')).join(' | '));
    assert.deepEqual(run.drafts, [{ text: 'A note for the room.', reason: 'skip-reply' }], 'the cut-off text, whole, as a skip_reply draft');
  });

  it("follows the agent's own 'ask', set with agent_settings in an earlier response, over a config of 'private'", async () => {
    const run = await turn('native', [
      { blocks: [{ call: 'agent_settings', json: ['{"action":"update","same_round_skip_reply_text_policy":"ask"}'], whole: true }], stop: 'tool_use' },
      { blocks: [{ text: 'A note for the room.' }, { call: 'skip_reply', json: ['{"wake_in_sec'], whole: false }], stop: 'max_tokens' },
    ], { sameRoundSkipReplyTextPolicy: 'private' });
    assert.equal(run.skipReplies, 0);
    assert.deepEqual(run.drafts, [{ text: 'A note for the room.', reason: 'skip-reply' }], 'the cut-off text, whole, as a skip_reply draft');
  });

  it('keeps a cut-off skip_reply\'s round private after an earlier round published its words', async () => {
    const run = await turn('native', [EAST_ROUND, { blocks: [{ text: 'A note to myself, not for the room.' }, { call: 'skip_reply', json: ['{"wake_in_sec'], whole: false }], stop: 'max_tokens' }]);
    assert.equal(run.skipReplies, 0);
    assertRefusedPair(run, [{ name: 'skip_reply', says: RAN_NOT }]);
    assert.deepEqual(run.routed, ['First I step east.', NEXT]);
    assert.equal(run.requests.length, 3);
  });

  it('keeps a cut-off round with a private think from being published after an earlier round published its words', async () => {
    const run = await turn('native', [EAST_ROUND, { blocks: [{ text: 'Musing to myself.' }, { call: 'think', json: ['{"thought": "is it'], whole: false }], stop: 'max_tokens' }],
      { sameRoundThinkTextPolicy: 'private' });
    assertRefusedPair(run, [{ name: 'think', says: RAN_NOT }]);
    assert.deepEqual(run.routed, ['First I step east.', NEXT]);
    assert.equal(run.requests.length, 3);
  });

  it('keeps a cut-off round with a private think from being published when it is the turn\'s first', async () => {
    const run = await turn('native', [{ blocks: [{ text: 'Musing to myself.' }, { call: 'think', json: ['{"thought": "is it'], whole: false }], stop: 'max_tokens' }],
      { sameRoundThinkTextPolicy: 'private' });
    assertRefusedPair(run, [{ name: 'think', says: RAN_NOT }]);
    assert.deepEqual(run.routed, [NEXT]);
    assert.equal(run.requests.length, 2);
  });

  it("counts a cut-off private think round's words as suppressed under disabled routing, as the turn's earlier round's are", async () => {
    const run = await turn('native', [EAST_ROUND, THINK_CUT], { proseRouting: 'disabled', sameRoundThinkTextPolicy: 'private' });
    assertRefusedPair(run, [{ name: 'think', says: RAN_NOT }]);
    assert.deepEqual(run.routed, []);
    assert.match(receipts(run)[0] ?? '', /\b2 plain-speech segment\(s\) kept in the transcript/, receipts(run).join(' | '));
    assert.equal(run.requests.length, 3);
  });

  it("counts a cut-off private think round's words as kept private on a turn an earlier send silenced", async () => {
    const run = await turn('native', [
      { blocks: [{ text: 'Telling the room.' }, { call: 'robot--send_message', json: ['{"text": "hi"}'], whole: true }], stop: 'tool_use' },
      THINK_CUT,
    ], { sameRoundThinkTextPolicy: 'private' });
    assertRefusedPair(run, [{ name: 'think', says: RAN_NOT }]);
    assert.deepEqual(run.routed, [NEXT]);
    assert.match(receipts(run)[0] ?? '', /\b1 plain-speech segment\(s\) kept private/, receipts(run).join(' | '));
    assert.equal(run.requests.length, 3);
  });

  for (const [label, reply] of [
    ['a private think', THINK_CUT],
    ['a skip_reply', { blocks: [{ text: 'A note to myself.' }, { call: 'skip_reply', json: ['{"wake'], whole: false }], stop: 'max_tokens' } as Reply],
  ] as const) {
    it(`counts the words of a turn's first round, cut off with ${label}, as suppressed under disabled routing`, async () => {
      const run = await turn('native', [reply], { proseRouting: 'disabled', sameRoundThinkTextPolicy: 'private' });
      assert.deepEqual(run.routed, []);
      assert.match(receipts(run)[0] ?? '', /\b1 plain-speech segment\(s\) kept in the transcript/, receipts(run).join(' | '));
      assert.equal(run.requests.length, 2);
    });
  }

  it("keeps a cut-off skip_reply's round private under hybrid routing after an earlier round published its words", async () => {
    const run = await turn('native', [EAST_ROUND, { blocks: [{ text: 'A note to myself, not for the room.' }, { call: 'skip_reply', json: ['{"wake_in_sec'], whole: false }], stop: 'max_tokens' }],
      { proseRouting: 'hybrid' });
    assert.equal(run.skipReplies, 0);
    assertRefusedPair(run, [{ name: 'skip_reply', says: RAN_NOT }]);
    assert.deepEqual(run.routed, ['First I step east.', NEXT]);
    assert.match(receipts(run)[0] ?? '', /\b1 plain-speech segment\(s\) kept private/, receipts(run).join(' | '));
    assert.equal(run.requests.length, 3);
  });

  it('keeps a cut-off round with a private think from being published under hybrid routing after an earlier round published its words', async () => {
    const run = await turn('native', [EAST_ROUND, THINK_CUT], { proseRouting: 'hybrid', sameRoundThinkTextPolicy: 'private' });
    assertRefusedPair(run, [{ name: 'think', says: RAN_NOT }]);
    assert.deepEqual(run.routed, ['First I step east.', NEXT]);
    assert.equal(run.requests.length, 3);
  });

  for (const [label, replies, routed, requests] of [
    ['alone', [] as Reply[], ['Telling the room now.', NEXT], 2],
    ['after an earlier round published its words', [EAST_ROUND], ['First I step east.', 'Telling the room now.', NEXT], 3],
  ] as const) {
    it(`publishes the words of a round whose send didn't run, ${label}, since it posted nothing`, async () => {
      const run = await turn('native', [...replies, { blocks: [
        { text: 'Telling the room now.' },
        { call: 'robot--send_message', json: ['{"text": "hello"}'], whole: true },
      ], stop: 'max_tokens' }]);
      assert.ok(!run.moves.some((input) => (input as { text?: string }).text === 'hello'), 'the send never ran');
      assertRefusedPair(run, [{ name: 'robot--send_message', says: RAN_NOT }]);
      assert.deepEqual(run.routed, routed);
      assert.equal(run.requests.length, requests);
    });
  }

  it('refuses a whole call in the same round too, since none of the round\'s calls ran', async () => {
    const run = await turn('native', [{ blocks: [
      { text: 'Two steps.' },
      { call: 'robot--move', json: ['{"dir": "east"}'], whole: true },
      { call: 'robot--move', json: ['{"dir": "no'], whole: false },
    ], stop: 'max_tokens' }]);
    assert.deepEqual(run.moves, []);
    assertRefusedPair(run, [{ name: 'robot--move', says: RAN_NOT }, { name: 'robot--move', says: RAN_NOT }]);
    assert.deepEqual(run.routed, ['Two steps.', NEXT]);
    assert.equal(run.requests.length, 2);
  });

  it('settles the refused results with the tool-result guard on, so the next request carries them', async () => {
    const run = await turn('native', [{ blocks: [{ text: 'Heading north now, to the gate.' }, { call: 'robot--move', json: ['{"dir": "no'], whole: false }], stop: 'max_tokens' }],
      { toolResultGuard: true });
    assertRefusedPair(run, [{ name: 'robot--move', says: RAN_NOT }]);
    assert.ok(!run.requests[1].includes('withheld by the guard'), 'not as the guard\'s withheld notice');
    assert.equal(run.requests.length, 2);
    const cutId = blocks(run, 'tool_use')[0]!.id;
    const staged = run.audit.find((record) => record.type === 'staged'
      && (record.originals as Array<{ id: string }>).some((call) => call.id === cutId));
    assert.ok(staged, 'the guard\'s audit record keeps the cut-off round\'s results');
    const original = (staged!.originals as Array<{ id: string; result: { refused?: boolean } }>).find((call) => call.id === cutId)!;
    assert.equal(original.result.refused, true, 'as refused, so the guard reads that nothing ran');
    const settled = run.audit.slice(run.audit.indexOf(staged!) + 1).find((record) => record.type === 'accepted' || record.type === 'withheld');
    assert.equal(settled?.type, 'accepted', 'and admits them, since the turn ended');
  });
});

describe('XML tools: a response that ends at the output limit inside a tool-call block', () => {
  const CUT = 'Heading north now, to the gate.\n\n<function_calls>\n<invoke name="robot--move">\n<parameter name="dir">no';

  it('stores the named call with a refused result, runs nothing, and keeps the block out of the reply\'s text and what is published', async () => {
    const run = await turn('xml', [{ xml: CUT, stop: 'max_tokens' }]);
    assert.deepEqual(run.moves, []);
    assertRefusedPair(run, [{ name: 'robot--move', says: RAN_NOT }]);
    assert.ok(noBlockText(run), replyTexts(run).join(' | '));
    assert.deepEqual(run.routed, ['Heading north now, to the gate.', NEXT]);
    assert.equal(replyTexts(run).at(-1), NEXT, 'the next answer is stored as written');
    assert.equal(run.requests.length, 2);
    assert.equal(run.boundaryLines.length, 1);
  });

  it('stores and publishes a whole round and the cut-off round\'s words, and the next answer as written', async () => {
    const run = await turn('xml', [XML_EAST_ROUND, { xml: 'Now north to the gate.\n\n<function_calls>\n<invoke name="robot--move">\n<parameter name="dir">no', stop: 'max_tokens' }]);
    assert.deepEqual(run.moves, [{ dir: 'east' }]);
    assertRefusedPair(run, [{ name: 'robot--move', says: RAN_NOT }]);
    assert.deepEqual(run.routed, ['First I step east.', 'Now north to the gate.', NEXT]);
    assert.equal(replyTexts(run).at(-1), NEXT);
    assert.equal(run.requests.length, 3);
  });

  it('refuses every call of the block, a whole one included, and runs none', async () => {
    const run = await turn('xml', [{ xml: 'Two steps.\n\n<function_calls>\n<invoke name="robot--move">\n<parameter name="dir">east</parameter>\n</invoke>\n<invoke name="robot--move">\n<parameter name="dir">no', stop: 'max_tokens' }]);
    assert.deepEqual(run.moves, []);
    assertRefusedPair(run, [{ name: 'robot--move', says: RAN_NOT }, { name: 'robot--move', says: RAN_NOT }]);
    assert.deepEqual(blocks(run, 'tool_use').map((block) => block.unparseableInput), [
      '<invoke name="robot--move">\n<parameter name="dir">east</parameter>\n</invoke>\n',
      '<invoke name="robot--move">\n<parameter name="dir">no',
    ], 'each call keeps its own part of the block as its marked arguments');
    assert.ok(noBlockText(run));
    assert.deepEqual(run.routed, ['Two steps.', NEXT]);
    assert.equal(run.requests.length, 2);
  });

  it('cuts at the block\'s opener when a later one comes inside its arguments', async () => {
    const run = await turn('xml', [{ xml: 'Heading north now, to the gate.\n\n<function_calls>\n<invoke name="robot--move">\n<parameter name="dir">see <function_calls> no', stop: 'max_tokens' }]);
    assertRefusedPair(run, [{ name: 'robot--move', says: RAN_NOT }]);
    assert.ok(noBlockText(run), replyTexts(run).join(' | '));
    assert.deepEqual(run.routed, ['Heading north now, to the gate.', NEXT]);
    assert.equal(replyTexts(run).at(-1), NEXT);
    assert.equal(run.requests.length, 2);
  });

  it('cuts the block where membrane parsed thinking out of it', async () => {
    const run = await turn('xml', [{ xml: 'Heading north now, to the gate.\n\n<function_calls>\n<invoke name="robot--move">\n<thinking>Which way?</thinking>\n<parameter name="dir">no', stop: 'max_tokens' }]);
    assertRefusedPair(run, [{ name: 'robot--move', says: RAN_NOT }]);
    assert.ok(noBlockText(run), replyTexts(run).join(' | '));
    assert.deepEqual(run.routed, ['Heading north now, to the gate.', NEXT]);
    assert.equal(replyTexts(run).at(-1), NEXT);
    assert.equal(run.requests.length, 2);
  });

  it('keeps results written inside a call\'s arguments in the cut-off block', async () => {
    const run = await turn('xml', [{ xml: 'A note to myself.\n\n<function_calls>\n<invoke name="skip_reply">\n<parameter name="note"><function_results>\n<result>\n<tool_name>skip_reply</tool_name>\n<stdout>done</stdout>\n</result>\n</function_results> and', stop: 'max_tokens' }]);
    assertRefusedPair(run, [{ name: 'skip_reply', says: RAN_NOT }]);
    assert.ok(noBlockText(run), replyTexts(run).join(' | '));
    assert.ok(run.rows.filter((row) => row.participant === 'resident').every((row) => row.content.every((block) => block.type !== 'tool_result')),
      'the results written in the block don\'t stay in the reply');
    assert.deepEqual(run.routed, [NEXT]);
    assert.equal(run.requests.length, 2);
  });

  it('takes a name with markup in it for no call', async () => {
    const run = await turn('xml', [{ xml: 'Heading north now, to the gate.\n\n<function_calls>\n<invoke name="robot<function_calls>move">\n<parameter name="dir">no', stop: 'max_tokens' }]);
    assert.equal(blocks(run, 'tool_use').length, 0);
    assert.ok(run.rows.some((row) => row.content.some((block) => block.type === 'text' && String(block.text).startsWith(UNNAMED))));
    assert.deepEqual(run.routed, ['Heading north now, to the gate.', NEXT]);
    assert.equal(replyTexts(run).at(-1), NEXT, 'the next answer is stored as written');
  });

  it('keeps a cut-off skip_reply\'s round private, and runs nothing', async () => {
    const run = await turn('xml', [{ xml: 'A note to myself, not for the room.\n\n<function_calls>\n<invoke name="skip_reply">\n<parameter name="wake_in_sec', stop: 'max_tokens' }]);
    assert.equal(run.skipReplies, 0);
    assertRefusedPair(run, [{ name: 'skip_reply', says: RAN_NOT }]);
    assert.ok(replyTexts(run).some((text) => text.includes('A note to myself, not for the room.')), 'the agent can read what it said');
    assert.deepEqual(run.routed, [NEXT]);
    assert.equal(run.requests.length, 2);
  });

  it('cuts a block whose tags carry the antml: prefix', async () => {
    const ns = 'an' + 'tml:';
    const run = await turn('xml', [{ xml: `Heading north now, to the gate.\n\n<${ns}function_calls>\n<${ns}invoke name="robot--move">\n<${ns}parameter name="dir">no`, stop: 'max_tokens' }]);
    assert.deepEqual(run.moves, []);
    assertRefusedPair(run, [{ name: 'robot--move', says: RAN_NOT }]);
    assert.ok(noBlockText(run), replyTexts(run).join(' | '));
    assert.deepEqual(run.routed, ['Heading north now, to the gate.', NEXT]);
    assert.equal(replyTexts(run).at(-1), NEXT);
    assert.equal(run.requests.length, 2);
  });

  it('refuses a call membrane read whole inside the cut-off block, and keeps a skip_reply\'s round private', async () => {
    const ns = 'an' + 'tml:';
    const run = await turn('xml', [{ xml: `A note to myself.\n\n<function_calls>\n<${ns}function_calls>\n<${ns}invoke name="skip_reply">\n</${ns}invoke>\n</${ns}function_calls>`, stop: 'max_tokens' }]);
    assert.equal(run.skipReplies, 0);
    assertRefusedPair(run, [{ name: 'skip_reply', says: RAN_NOT }]);
    assert.ok(!run.rows.some((row) => row.content.some((block) => block.type === 'text' && String(block.text).startsWith(UNNAMED))), 'a call was named');
    assert.deepEqual(run.routed, [NEXT]);
    assert.equal(run.requests.length, 2);
  });

  it('routes the words of a cut-off round whose think membrane read whole as an XML round\'s, outside the private think policy', async () => {
    const ns = 'an' + 'tml:';
    const run = await turn('xml', [{ xml: `Words here.\n\n<${ns}function_calls>\n<${ns}invoke name="think">\n<${ns}parameter name="thought">hm</${ns}parameter>\n</${ns}invoke>\n</${ns}function_calls>\nMore words`, stop: 'max_tokens' }],
      { sameRoundThinkTextPolicy: 'private' });
    assertRefusedPair(run, [{ name: 'think', says: RAN_NOT }]);
    assert.ok(run.routed.some((text) => text.includes('Words here.')), JSON.stringify(run.routed));
    assert.equal(run.routed.at(-1), NEXT);
    assert.equal(run.requests.length, 2);
  });

  it('tells the agent nothing ran when an earlier round ran and the next block was cut off before any call was named', async () => {
    const run = await turn('xml', [XML_EAST_ROUND, { xml: 'Now north to the gate.\n\n<function_calls>\n<invoke name="robo', stop: 'max_tokens' }]);
    assert.deepEqual(run.moves, [{ dir: 'east' }]);
    assert.deepEqual(blocks(run, 'tool_use').map((block) => block.name), ['robot--move'], 'only the call that ran is stored');
    assert.ok(run.rows.some((row) => row.content.some((block) => block.type === 'text' && String(block.text).startsWith(UNNAMED))));
    assert.ok(replyTexts(run).some((text) => text.includes('Now north to the gate.')), 'the words are stored');
    assert.ok(noBlockText(run), replyTexts(run).join(' | '));
    assert.deepEqual(run.routed, ['First I step east.', 'Now north to the gate.', NEXT]);
    assert.equal(replyTexts(run).at(-1), NEXT);
    assert.equal(run.requests.length, 3);
  });

  for (const [label, xml, words] of [
    ['right after the block opened', 'Heading north now, to the gate.\n\n<function_calls>\n', ['Heading north now, to the gate.']],
    ['inside the first call\'s name', 'Heading north now, to the gate.\n\n<function_calls>\n<invoke name="robo', ['Heading north now, to the gate.']],
    ['before any words', '<function_calls>\n<invoke name="robo', []],
    ['inside its own opener, before its \'>\'', 'Heading north now, to the gate.\n\n<function_calls', ['Heading north now, to the gate.']],
  ] as const) {
    it(`tells the agent nothing ran when the block was cut off ${label}, and publishes the words before it`, async () => {
      const run = await turn('xml', [{ xml, stop: 'max_tokens' }]);
      assert.deepEqual(run.moves, []);
      assert.equal(blocks(run, 'tool_use').length, 0);
      assert.ok(run.rows.some((row) => row.content.some((block) => block.type === 'text' && String(block.text).startsWith(UNNAMED))));
      assert.ok(run.requests[run.requests.length - 1].includes(UNNAMED), 'the next request tells the agent');
      assert.ok(run.rows.every((row) => row.content.length > 0), 'no empty reply is stored');
      for (const word of words) assert.ok(replyTexts(run).some((text) => text.includes(word)), 'the words are stored');
      assert.deepEqual(run.routed, [...words, NEXT]);
      assert.equal(replyTexts(run).at(-1), NEXT);
      assert.equal(run.boundaryLines.length, 1);
      assert.equal(run.requests.length, 2);
    });
  }
});

describe('an ephemeral run whose response ends at the output limit with calls in its last round', () => {
  it('gives no speech from that round, so a cut-off skip_reply\'s words stay private', async () => {
    const requests: string[] = [];
    const server: Server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (String(req.url).includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ input_tokens: 10 }));
          return;
        }
        requests.push(raw);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse({ blocks: [{ text: 'A note to myself.' }, { call: 'skip_reply', json: ['{"wake'], whole: false }], stop: 'max_tokens' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, cacheKeepalive: { enabled: false } } as never);
    const dir = mkdtempSync(join(tmpdir(), 'af-cut-off-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: new Membrane(adapter), agents: [], modules: [new Robot()], syncIntervalMs: 0,
    });
    const error = console.error;
    console.error = () => {};
    try {
      framework.start();
      const { agent, contextManager } = await framework.createEphemeralAgent({
        name: 'worker', model: 'claude-opus-5-5', systemPrompt: 'Do the task.', sendSilencing: true, allowedTools: 'all', proseRouting: 'disabled',
      });
      contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      const result = await framework.runEphemeralToCompletion(agent, contextManager);
      assert.equal(result.speech, '');
      assert.equal(requests.length, 1);
    } finally {
      console.error = error;
      await framework.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sameRoundSkipReplyTextPolicy 'ask' on the XML tool path: what a skip_reply leaves unsent is held at the turn's end", () => {
  const ASK = { sameRoundSkipReplyTextPolicy: 'ask' };
  const skipRound = (text: string, input = '<parameter name="reason">done</parameter>\n'): Reply =>
    ({ xml: `${text}\n\n<function_calls>\n<invoke name="skip_reply">\n${input}</invoke>\n`, stop: 'stop_sequence' });
  const refusedWake = (text: string): Reply => skipRound(text, '<parameter name="wake_in_seconds">60</parameter>\n');
  const SECOND = 'Second words for the room.';
  /** The texts of the run's 'skip-reply' drafts, trimmed (the parse decides a run's whitespace), sorted (the store lists the newest first). */
  const skipHeld = (run: Run): string[] => run.held.filter((d) => d.reason === 'skip-reply').map((d) => d.text.trim()).sort();
  const receipts = (run: Run) => run.rows.flatMap((row) => row.content.filter((block) => block.type === 'text').map((block) => block.text as string))
    .filter((t) => t.startsWith('[delivered]'));

  it('a turn of two rounds ended by a skip_reply: both rounds\' text are skip-reply drafts, nothing of the turn is posted, and the receipt names them', async () => {
    const run = await turn('xml', [XML_EAST_ROUND, skipRound(SECOND)], ASK);
    assert.equal(run.skipReplies, 1, 'premise: the skip_reply ran');
    assert.deepEqual(skipHeld(run), ['First I step east.', SECOND].sort());
    assert.deepEqual(run.routed, [NEXT], 'only the next turn\'s answer is posted');
    const receipt = receipts(run)[0] ?? '';
    assert.ok(run.held.every((d) => receipt.includes(d.id)), receipt);
  });

  it("under 'private' the same turn posts nothing and holds nothing, as before", async () => {
    const run = await turn('xml', [XML_EAST_ROUND, skipRound(SECOND)]);
    assert.deepEqual(run.held, []);
    assert.deepEqual(run.routed, [NEXT]);
  });

  it('hybrid mode: a >>>target round\'s text is held with that destination, and nothing is published', async () => {
    const run = await turn('xml', [
      { xml: '>>>#ops To the ops room.\n\n<function_calls>\n<invoke name="robot--move">\n<parameter name="dir">east</parameter>\n</invoke>\n', stop: 'stop_sequence' },
      skipRound(SECOND),
    ], { ...ASK, proseRouting: 'hybrid' }, { resolves: { '#ops': 'ops' } });
    const ops = run.held.find((d) => d.text === 'To the ops room.');
    assert.deepEqual(ops && [ops.reason, ops.note], ['skip-reply', 'written for >>>#ops'], JSON.stringify(run.held));
    assert.ok(skipHeld(run).includes(SECOND), JSON.stringify(run.held));
    assert.ok(!run.routed.some((t) => t.includes('ops room') || t === SECOND), JSON.stringify(run.routed));
  });

  it('explicit mode: what would have been posted or bounced is held', async () => {
    const run = await turn('xml', [
      { xml: '>>#ops To the ops room.\n\n<function_calls>\n<invoke name="robot--move">\n<parameter name="dir">east</parameter>\n</invoke>\n', stop: 'stop_sequence' },
      skipRound(SECOND),
    ], { ...ASK, proseRouting: 'explicit' }, { resolves: { '#ops': 'ops' } });
    assert.deepEqual(skipHeld(run), ['To the ops room.', SECOND].sort());
    assert.ok(!run.routed.some((t) => t.includes('ops room') || t === SECOND), JSON.stringify(run.routed));
  });

  it("explicit mode: a held round's ` !` asks for no continuation, as a skip_reply round's doesn't", async () => {
    const run = await turn('xml', [skipRound('>>#ops ! To the ops room.')], { ...ASK, proseRouting: 'explicit' }, { resolves: { '#ops': 'ops' } });
    assert.deepEqual(skipHeld(run), ['To the ops room.']);
    assert.equal(run.requests.findIndex((r) => r.includes('And next?')), 1, 'no continuation request before the next message');
  });

  it("native tools: a turn that a skip_reply ends holds nothing at the turn's end, so text already posted isn't held again", async () => {
    const run = await turn('native', [
      { blocks: [{ text: 'Posted words.' }, { call: 'robot--move', json: ['{"dir":"east"}'], whole: true }], stop: 'tool_use' },
      { blocks: [{ call: 'skip_reply', json: ['{"reason":"done"}'], whole: true }], stop: 'tool_use' },
    ], ASK);
    assert.equal(run.skipReplies, 1, 'premise: the skip_reply ran');
    assert.equal(run.routed[0], 'Posted words.');
    assert.deepEqual(skipHeld(run), []);
  });

  it("a round whose text holds thinking: the draft holds the speech and none of the thinking", async () => {
    const run = await turn('xml', [skipRound('<thinking>Should I answer at all?</thinking>\nVisible words.')], ASK);
    assert.deepEqual(skipHeld(run), ['Visible words.']);
  });

  it("a heartbeat turn ended by a skip_reply: its text is held, and that turn's notice had no clause", async () => {
    const run = await turn('xml', [skipRound('Heartbeat words.')], ASK, { heartbeat: true });
    assert.deepEqual(skipHeld(run), ['Heartbeat words.']);
    const notice = run.rows.flatMap((row) => row.content.filter((block) => block.type === 'text').map((block) => block.text as string))
      .find((t) => t.startsWith('[routing] This turn came from your heartbeat'));
    assert.equal(notice, "[routing] This turn came from your heartbeat, not from a channel, so plain speech here isn't posted: it's held as a draft you can send with the drafts tool. An explicit send reaches a channel now.");
  });

  it('a skip_reply refused for its wake, then a reply, then a natural end: the reply is posted, and the refused round\'s text is held', async () => {
    const run = await turn('xml', [refusedWake('Not yet.'), { xml: 'Here is my reply.', stop: 'end_turn' }], ASK);
    assert.equal(run.skipReplies, 0, 'premise: the skip_reply was refused for its wake');
    assert.deepEqual(run.routed, ['Here is my reply.', NEXT]);
    assert.deepEqual(skipHeld(run), ['Not yet.']);
  });

  it("hybrid mode: a round refused for its wake is held in its place, and its >>>target still sets where the next round's plain text goes", async () => {
    const run = await turn('xml', [refusedWake('>>>#ops Not yet.'), { xml: 'Here is my reply.', stop: 'end_turn' }], { ...ASK, proseRouting: 'hybrid' }, { resolves: { '#ops': 'ops' } });
    assert.deepEqual(skipHeld(run), ['Not yet.']);
    assert.deepEqual(run.routedTo[0], ['ops', 'Here is my reply.']);
  });

  it('a skip_reply refused for its wake, then a skip_reply that runs: both rounds\' text are held', async () => {
    const run = await turn('xml', [refusedWake('Not yet.'), skipRound('Never mind.')], ASK);
    assert.equal(run.skipReplies, 1, 'premise: the second skip_reply ran');
    assert.deepEqual(skipHeld(run), ['Never mind.', 'Not yet.']);
    assert.deepEqual(run.routed, [NEXT]);
  });

  it("a response cut off with a skip_reply among its unrun calls: the cut round's text is held, and the earlier round's is posted", async () => {
    const run = await turn('xml', [XML_EAST_ROUND, { xml: 'A note for the room.\n\n<function_calls>\n<invoke name="skip_reply">\n<parameter name="wake_in_sec', stop: 'max_tokens' }], ASK);
    assert.equal(run.skipReplies, 0);
    assert.deepEqual(run.routed, ['First I step east.', NEXT]);
    assert.deepEqual(skipHeld(run), ['A note for the room.']);
  });

  it('a message that arrives during the turn, so a wake is pending when the skip_reply ends it, leaves the hold whole', async () => {
    class Pinger implements Module {
      readonly name = 'pinger';
      private ctx?: ModuleContext;
      async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] { return [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } }]; }
      async handleToolCall(_call: ToolCall): Promise<ToolResult> {
        this.ctx!.pushEvent({ type: 'external-message', source: 'test', content: 'Ping!', metadata: {} } as unknown as ProcessEvent);
        return { success: true, data: { pinged: true } };
      }
      async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
    }
    const run = await turn('xml', [
      { xml: 'First words.\n\n<function_calls>\n<invoke name="pinger--ping">\n</invoke>\n', stop: 'stop_sequence' },
      skipRound(SECOND),
    ], ASK, { modules: [new Pinger()] });
    assert.deepEqual(skipHeld(run), ['First words.', SECOND].sort());
    const receipt = receipts(run)[0] ?? '';
    assert.ok(run.held.every((d) => d.reason !== 'skip-reply' || receipt.includes(d.id)), receipt);
  });

  it("native tools: a first response cut off in a round with a private think holds nothing, as the think policy keeps the text private", async () => {
    const run = await turn('native', [THINK_CUT], { ...ASK, sameRoundThinkTextPolicy: 'private' });
    assert.deepEqual(skipHeld(run), []);
    assert.deepEqual(run.routed, [NEXT]);
  });

  it("explicit mode writes no receipt: the draft notice at the agent's next turn names the held drafts", async () => {
    const run = await turn('xml', [XML_EAST_ROUND, skipRound(SECOND)], { ...ASK, proseRouting: 'explicit' });
    const ids = run.held.filter((d) => d.reason === 'skip-reply').map((d) => d.id);
    assert.equal(ids.length, 2, JSON.stringify(run.held));
    const next = run.requests.find((r) => r.includes('And next?')) ?? '';
    assert.ok(ids.every((id) => next.includes(id)), 'each id in the next request');
    assert.equal(receipts(run).length, 0, receipts(run).join(' | '));
  });

  it("the hold reads the value in force: an agent whose config is 'private' sets 'ask' with agent_settings, and its turn's text is held", async () => {
    const run = await turn('xml', [
      { xml: 'First words.\n\n<function_calls>\n<invoke name="agent_settings">\n<parameter name="action">update</parameter>\n<parameter name="same_round_skip_reply_text_policy">ask</parameter>\n</invoke>\n', stop: 'stop_sequence' },
      skipRound(SECOND),
    ]);
    assert.deepEqual(skipHeld(run), ['First words.', SECOND].sort(), JSON.stringify(blocks(run, 'tool_result').map(toolResultText)));
  });

  it("the hold reads the value in force when the turn ends: 'ask' set in the response that calls skip_reply applies to it", async () => {
    const run = await turn('xml', [
      { xml: 'Same-response words.\n\n<function_calls>\n<invoke name="agent_settings">\n<parameter name="action">update</parameter>\n<parameter name="same_round_skip_reply_text_policy">ask</parameter>\n</invoke>\n<invoke name="skip_reply">\n<parameter name="reason">done</parameter>\n</invoke>\n', stop: 'stop_sequence' },
    ]);
    assert.equal(run.skipReplies, 1, 'premise: the skip_reply ran');
    assert.deepEqual(skipHeld(run), ['Same-response words.'], JSON.stringify(blocks(run, 'tool_result').map(toolResultText)));
  });

  it("the same-round think policy acts on native tools only: on this path, text beside think is held like any other", async () => {
    const run = await turn('xml', [
      { xml: 'Beside a think.\n\n<function_calls>\n<invoke name="think">\n<parameter name="thought">hm</parameter>\n</invoke>\n<invoke name="skip_reply">\n<parameter name="reason">done</parameter>\n</invoke>\n', stop: 'stop_sequence' },
    ], { ...ASK, sameRoundThinkTextPolicy: 'private' });
    assert.deepEqual(skipHeld(run), ['Beside a think.'], JSON.stringify(blocks(run, 'tool_result').map(toolResultText)));
  });

  it('a turn that another tool ends is as before: nothing is held', async () => {
    class Rest implements Module {
      readonly name = 'rest';
      async start(_ctx: ModuleContext): Promise<void> {}
      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] { return [{ name: 'now', description: 'Rest now', inputSchema: { type: 'object', properties: {} } }]; }
      async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: { resting: true }, endTurn: true }; }
      async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
    }
    const run = await turn('xml', [{ xml: 'Resting now.\n\n<function_calls>\n<invoke name="rest--now">\n</invoke>\n', stop: 'stop_sequence' }], ASK, { modules: [new Rest()] });
    assert.ok(run.requests.length >= 1);
    assert.deepEqual(run.held, []);
    assert.ok(!run.routed.includes('Resting now.'), JSON.stringify(run.routed));
  });

  it("a script's skip_reply ends the turn: the turn's text is held", async () => {
    const run = await turn('xml', [
      { xml: 'Scripted words.\n\n<function_calls>\n<invoke name="code_execution">\n<parameter name="code">await tools.skip_reply({ reason: "done" });</parameter>\n</invoke>\n', stop: 'stop_sequence' },
    ], ASK, { framework: { codeExecution: { enabled: true } }, channelTools: [{ name: 'skip_reply', description: 'End the turn without replying.', inputSchema: { type: 'object', properties: { reason: { type: 'string' } } } }] });
    assert.equal(run.skipReplies, 1, `premise: the script's skip_reply ran; ${JSON.stringify(blocks(run, 'tool_result').map(toolResultText))}`);
    assert.deepEqual(skipHeld(run), ['Scripted words.']);
  });
});

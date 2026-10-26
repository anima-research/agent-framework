import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicAdapter, AnthropicXmlFormatter, Membrane } from '@animalabs/membrane';

import { AgentFramework } from '../src/index.js';
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
  rows: Array<{ participant: string; content: Array<Record<string, any>> }>;
  requests: string[];
  boundaryLines: string[];
}

async function turn(mode: 'native' | 'xml', replies: Reply[], settings: Record<string, unknown> = {}): Promise<Run> {
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
    agents: [{ name: 'resident', model: mode === 'xml' ? 'claude-opus-4-1' : 'claude-opus-5-5', systemPrompt: 'You are a resident.', proseRouting: 'locus', ...settings } as never],
    modules: [robot],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  const routed: string[] = [];
  let skipReplies = 0;
  const deliver = async (_agent: string, text: string, locus?: { channelId: string } | null) => {
    routed.push(text);
    return { status: 'delivered' as const, destination: { serverId: 'stub', channelId: locus?.channelId ?? 'world:commons' }, at: Date.now() };
  };
  const registry: Record<string, unknown> = {
    deliverSpeech: deliver,
    routeSpeech: async (agent: string, text: string, locus?: { channelId: string } | null) => {
      await deliver(agent, text, locus);
      return { delivered: true, serverId: 'stub', channelId: locus?.channelId ?? 'world:commons' };
    },
    resolveProseTarget: (spec: string) => ({ error: `no channel matches "${spec}"` }),
    resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: 'stub', channelId } }),
    resolveLocus: () => ({ serverId: 'stub', channelId: 'world:commons' }),
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
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
  const lines: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'And next?', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    const cm = framework.getAgent('resident')!.getContextManager() as unknown as { getAllMessages(): Run['rows'] };
    return {
      mode,
      moves: robot.moves,
      skipReplies,
      routed: [...routed],
      rows: cm.getAllMessages(),
      requests,
      boundaryLines: lines.filter((line) => line.startsWith('[tool-boundary]')),
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
    assert.ok(next.includes(refusal), 'the next request carries it');
    assert.ok(run.mode === 'native' ? next.includes(`"id":"${result.toolUseId}"`) : next.includes(`invoke name=\\"${name}\\"`),
      'with the call it answers');
  }
  assert.equal(new Set(refusals.map((block) => block.toolUseId)).size, refusals.length, 'each answers a call of its own');
}

const EAST_ROUND: Reply = { blocks: [{ text: 'First I step east.' }, { call: 'robot--move', json: ['{"dir": "east"}'], whole: true }], stop: 'tool_use' };
const XML_EAST_ROUND: Reply = { xml: 'First I step east.\n\n<function_calls>\n<invoke name="robot--move">\n<parameter name="dir">east</parameter>\n</invoke>\n', stop: 'stop_sequence' };
const noBlockText = (run: Run) => replyTexts(run).every((text) => !/<(antml:)?(function_calls|invoke|parameter)/.test(text));

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

  for (const [label, xml, words] of [
    ['right after the block opened', 'Heading north now, to the gate.\n\n<function_calls>\n', ['Heading north now, to the gate.']],
    ['inside the first call\'s name', 'Heading north now, to the gate.\n\n<function_calls>\n<invoke name="robo', ['Heading north now, to the gate.']],
    ['before any words', '<function_calls>\n<invoke name="robo', []],
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
        name: 'worker', model: 'claude-opus-5-5', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'disabled',
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

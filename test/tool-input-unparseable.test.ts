import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/framework.js';
import type { Module, ModuleContext, ProcessEvent, ToolCall } from '../src/types/index.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { ToolLifecycleEmitter, type ToolLifecycleParams } from '../src/mcpl/tool-lifecycle.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'tool-input-unparseable-'));
  const membrane = new MockMembrane();
  const effects: ToolCall[] = [];
  let moduleContext: ModuleContext;
  const module: Module = {
    name: 'probe',
    async start(ctx) { moduleContext = ctx; },
    async stop() {},
    getTools: () => [{
      name: 'move', description: 'Move', inputSchema: { type: 'object', properties: { steps: { type: 'number' } } },
    }],
    async handleToolCall(call) {
      effects.push(call);
      return { success: true, data: 'moved' };
    },
    async onProcess(event) {
      return event.type === 'external-message'
        ? { addMessages: [{ participant: 'user', content: [{ type: 'text', text: 'Go' }] }], requestInference: true }
        : {};
    },
  };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'Test' }],
    modules: [module], syncIntervalMs: 0, codeExecution: { enabled: true },
  });
  const traces: Array<Record<string, unknown>> = [];
  framework.onTrace((event) => traces.push(event as unknown as Record<string, unknown>));
  const lifecycle: ToolLifecycleParams[] = [];
  (framework as unknown as { toolLifecycleEmitter: ToolLifecycleEmitter }).toolLifecycleEmitter = new ToolLifecycleEmitter({
    observers: () => [{
      id: 'observer', grant: new CapabilityGrant(new Set(['toolLifecycle.observe']), []),
      toolObserveFilter: null, sendToolLifecycle: (event) => lifecycle.push(event),
    }],
    configFor: () => undefined, describe: () => ({ class: [] }),
  });
  return {
    framework, membrane, effects, traces, lifecycle,
    moduleCall: (call: ToolCall) => moduleContext.callTool(call),
    async turn(blocks: ContentBlock[]) {
      membrane.pushResponse(createMockResponse(blocks, 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public trailing prose' } as ContentBlock]));
      framework.pushEvent({ type: 'external-message', source: 'probe', content: 'Go', metadata: {} });
      await framework.runUntilIdle();
      return (membrane.lastStream?.receivedToolResults[0] ?? []) as Array<{ toolUseId: string; content: string; isError?: boolean }>;
    },
    async close() { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function marked(unparseableInput: string | undefined, name = 'probe--move', input: Record<string, unknown> = {}): ContentBlock {
  return { type: 'tool_use', id: 'call-1', name, input, ...(unparseableInput !== undefined ? { unparseableInput } : {}) } as ContentBlock;
}

function captureRouting(framework: AgentFramework) {
  const routed: string[] = [];
  const registry: Record<string, unknown> = {
    handleChannelToolCall: async () => ({ success: true, data: 'ok' }),
    routeSpeech: async (_agent: string, text: string) => { routed.push(text); return { delivered: true, serverId: 'stub', channelId: 'world:commons' }; },
    resolveLocus: () => ({ serverId: 'stub', channelId: 'world:commons' }), getDefaultPublishChannel: () => null,
    isChannelOpen: () => true, getDescriptor: () => undefined, getChannelTools: () => [],
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(registry, {
    get: (target, prop: string) => prop in target ? target[prop] : () => undefined,
  });
  return routed;
}

/** XML tool mode, as an older membrane streams it: no round carries its
 *  roundContent, so none is routed live, and the turn's completion holds the
 *  tool round, its prose, its call and its result before the final text. */
function asXmlTurn(membrane: MockMembrane, call: ContentBlock): void {
  const streamYielding = membrane.streamYielding.bind(membrane);
  membrane.streamYielding = (request, options) => {
    const stream = streamYielding(request, options);
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = async function* () {
      for await (const event of { [Symbol.asyncIterator]: iterate }) {
        if (event.type === 'tool-calls') {
          yield { ...event, context: { ...event.context, roundContent: undefined } };
        } else if (event.type === 'complete') {
          const id = (call as { id: string }).id;
          const round = [{ type: 'text' as const, text: 'Public round prose' }, call, { type: 'tool_result' as const, toolUseId: id, content: 'result' }];
          yield { ...event, response: { ...event.response, content: [...round, ...event.response.content] } };
        } else yield event;
      }
    };
    return stream;
  };
}

const long = `{"steps": "${'x'.repeat(200)}`;

const refusals: Array<{ marker: string; says: string; why: string }> = [
  { marker: '{"steps": 1', says: 'Nothing was done: probe--move its arguments must be one JSON object, and this call gave text that isn\'t JSON, which may have been cut off: "{\\"steps\\": 1".', why: 'text that isn\'t JSON, shown' },
  { marker: '', says: 'Nothing was done: probe--move its arguments never arrived; call it again with them whole.', why: 'nothing of its arguments' },
  { marker: ' \n', says: 'Nothing was done: probe--move its arguments never arrived; call it again with them whole.', why: 'only whitespace' },
  { marker: '[1,2]', says: 'Nothing was done: probe--move its input must be an object, and this call gave an array.', why: 'an array' },
  { marker: '5', says: 'Nothing was done: probe--move its input must be an object, and this call gave a number.', why: 'a number' },
  { marker: '"steps"', says: 'Nothing was done: probe--move its input must be an object, and this call gave a string.', why: 'a string' },
  { marker: 'true', says: 'Nothing was done: probe--move its input must be an object, and this call gave a boolean.', why: 'a boolean' },
  { marker: '{"steps":5}', says: 'Nothing was done: probe--move its arguments came in a response that didn\'t arrive whole and in order, so they can\'t be taken as this call\'s; call it again.', why: 'an object from a response that didn\'t arrive whole and in order' },
];

for (const { marker, says, why } of refusals) {
  test(`a model's call that membrane marks with ${why} doesn't run, and the model is told why`, async () => {
    const h = await harness();
    try {
      const results = await h.turn([marked(marker)]);
      assert.deepEqual(h.effects, [], 'the tool never ran');
      assert.equal(results.length, 1, 'the turn went on with a result for the call');
      assert.equal(results[0]!.toolUseId, 'call-1');
      assert.equal(results[0]!.isError, true);
      assert.equal(results[0]!.content, says);
      assert.deepEqual(h.lifecycle.filter((event) => event.tool === 'probe--move'), [], 'no tool lifecycle event: the call never started');
    } finally { await h.close(); }
  });
}

test("a refusal shows only the start of the model's text", async () => {
  const h = await harness();
  try {
    const [result] = await h.turn([marked(long)]);
    assert.ok(result!.content.includes('"{\\"steps\\": \\"xxxxxxxxxx'), result!.content);
    assert.ok(result!.content.endsWith('….'), result!.content);
    assert.ok(!result!.content.includes('x'.repeat(100)), 'the rest of the text is left out');
    assert.deepEqual(h.effects, []);
  } finally { await h.close(); }
});

test('a call marked as JSON null runs as a call with no arguments, whatever input its block carried', async () => {
  const h = await harness();
  try {
    const results = await h.turn([marked('null', 'probe--move', { steps: 9 })]);
    assert.deepEqual(h.effects.map((call) => call.input), [{}], 'the tool ran once with no arguments');
    assert.equal(results[0]!.isError, false);
  } finally { await h.close(); }
});

test('an unmarked call runs as it came', async () => {
  const h = await harness();
  try {
    const results = await h.turn([marked(undefined, 'probe--move', { steps: 9 })]);
    assert.deepEqual(h.effects.map((call) => call.input), [{ steps: 9 }]);
    assert.equal(results[0]!.isError, false);
    assert.deepEqual(h.lifecycle.filter((event) => event.tool === 'probe--move').map((event) => event.phase), ['started', 'completed']);
  } finally { await h.close(); }
});

test('each call of a round is decided on its own marker', async () => {
  const h = await harness();
  try {
    const results = await h.turn([
      { ...marked('[1]'), id: 'refused' } as ContentBlock,
      { ...marked('null'), id: 'runs' } as ContentBlock,
    ]);
    assert.deepEqual(h.effects.map((call) => call.id), ['runs']);
    const byId = Object.fromEntries(results.map((result) => [result.toolUseId, result.isError]));
    assert.deepEqual(byId, { refused: true, runs: false });
  } finally { await h.close(); }
});

test('a marked call queued as a tool-call event, or sent to a module through callTool, does not run', async () => {
  const h = await harness();
  try {
    const result = await h.moduleCall({ id: 'from-module', name: 'probe--move', input: {}, unparseableInput: '[1]' });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Nothing was done: probe--move its input must be an object, and this call gave an array.');
    for (const [id, unparseableInput] of [['queued', '{"steps": 1'], ['queued-null', 'null']]) {
      h.framework.pushEvent({
        type: 'tool-call', callId: id, agentName: 'assistant', moduleName: 'probe', toolName: 'move',
        call: { id, name: 'probe--move', input: { steps: 9 }, unparseableInput },
      } as unknown as ProcessEvent);
    }
    await h.framework.runUntilIdle();
    assert.deepEqual(h.effects.map((call) => [call.id, call.input]), [['queued-null', {}]], 'only the null-marked call ran, with no arguments');
  } finally { await h.close(); }
});

test('a refused marked skip_reply keeps its own round private and silences nothing after it', async () => {
  const h = await harness();
  try {
    const routed = captureRouting(h.framework);
    const results = await h.turn([
      { type: 'text', text: 'Public round prose' } as ContentBlock,
      marked('{"reason": "done', 'skip_reply'),
    ]);
    assert.equal(results[0]!.isError, true);
    assert.match(results[0]!.content, /^Nothing was done: skip_reply its arguments must be one JSON object/);
    assert.ok(!routed.includes('Public round prose'), "the model's choice to keep the round private holds");
    assert.ok(routed.includes('Public trailing prose'), 'the refused call silences nothing after it');
  } finally { await h.close(); }
});

test('a refused marked send counts for nothing: its round goes out, and so does what follows', async () => {
  const h = await harness();
  try {
    const routed = captureRouting(h.framework);
    const results = await h.turn([
      { type: 'text', text: 'Public round prose' } as ContentBlock,
      marked('{"content": "hel', 'channel_publish'),
    ]);
    assert.equal(results[0]!.isError, true);
    assert.ok(routed.includes('Public round prose'), "a refused send's round goes out");
    assert.ok(routed.includes('Public trailing prose'));
  } finally { await h.close(); }
});

test('in XML tool mode, where no round is routed live, a refused marked skip_reply silences nothing after its round', async () => {
  const h = await harness();
  try {
    const routed = captureRouting(h.framework);
    const call = marked('{"reason": "done', 'skip_reply');
    asXmlTurn(h.membrane, call);
    const results = await h.turn([{ type: 'text', text: 'Public round prose' } as ContentBlock, call]);
    assert.equal(results[0]!.isError, true);
    assert.ok(routed.includes('Public trailing prose'), 'the refused call silences nothing after it');
  } finally { await h.close(); }
});

test('a refused marked code_execution call starts no script, and its round does not wait for one', async () => {
  const h = await harness();
  try {
    const routed = captureRouting(h.framework);
    const code = 'await tools.skip_reply({});';
    const results = await h.turn([
      { type: 'text', text: 'Public round prose' } as ContentBlock,
      marked(JSON.stringify({ code }), 'code_execution', { code }),
    ]);
    assert.equal(results[0]!.isError, true);
    assert.match(results[0]!.content, /^Nothing was done: code_execution its arguments came in a response that didn't arrive whole and in order/);
    const scripts = (h.framework as unknown as { codeExecution: { scripts: { list(agent: string): unknown[] } } }).codeExecution.scripts;
    assert.deepEqual(scripts.list('assistant'), [], 'no script started');
    assert.ok(routed.includes('Public round prose'), "the round's prose went out");
    assert.ok(routed.includes('Public trailing prose'));
  } finally { await h.close(); }
});

test('a marked call through executeToolCall is a failure before the tool runs', async () => {
  const h = await harness();
  try {
    const result = await h.framework.executeToolCall({
      id: 'programmatic', name: 'probe--move', input: {}, unparseableInput: '[1]', callerAgentName: 'assistant',
    });
    assert.equal(result.success, false);
    assert.equal(result.isError, true);
    assert.equal(result.error, 'Nothing was done: probe--move its input must be an object, and this call gave an array.');
    assert.equal(h.effects.length, 0, 'the tool never ran');
    const traced = h.traces.filter((e) => e.callId === 'programmatic' && e.type === 'tool:failed');
    assert.equal(traced.length, 1, 'the failure is traced once');
    const ran = await h.framework.executeToolCall({
      id: 'programmatic-null', name: 'probe--move', input: { steps: 9 }, unparseableInput: 'null', callerAgentName: 'assistant',
    });
    assert.equal(ran.success, true);
    assert.deepEqual(h.effects.map((call) => call.input), [{}], 'a null-marked call runs with no arguments');
  } finally { await h.close(); }
});

test('a null-marked call through executeToolCall reaches a channel tool with no arguments', async () => {
  const h = await harness();
  try {
    const inputs: unknown[] = [];
    (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      handleChannelToolCall: async (_name: string, input: unknown) => { inputs.push(input); return { success: true, data: 'ok' }; },
    } as Record<string, unknown>, { get: (target, prop: string) => prop in target ? target[prop] : () => undefined });
    const result = await h.framework.executeToolCall({
      id: 'channel-null', name: 'channel_publish', input: { content: 'from the block start' }, unparseableInput: 'null', callerAgentName: 'assistant',
    });
    assert.equal(result.success, true);
    assert.deepEqual(inputs, [{}]);
  } finally { await h.close(); }
});

test("runInference's tool calls carry membrane's marker", async () => {
  const h = await harness();
  try {
    h.membrane.pushResponse(createMockResponse([{ ...marked(''), id: 'a' } as ContentBlock, { ...marked('[1]'), id: 'b' } as ContentBlock], 'tool_use'));
    const result = await h.framework.getAgent('assistant')!.runInference(h.framework.getAllTools());
    assert.deepEqual(result.toolCalls.map((call) => call.unparseableInput), ['', '[1]']);
  } finally { await h.close(); }
});

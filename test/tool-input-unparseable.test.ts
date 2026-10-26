import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/framework.js';
import type { Module, ToolCall } from '../src/types/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'tool-input-unparseable-'));
  const membrane = new MockMembrane();
  const effects: ToolCall[] = [];
  const module: Module = {
    name: 'probe',
    async start() {},
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
  return {
    framework, membrane, effects, traces,
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

const long = `{"steps": "${'x'.repeat(200)}`;

const refusals: Array<{ marker: string; says: string; why: string }> = [
  { marker: '{"steps": 1', says: 'Nothing was done: probe--move its arguments must be one JSON object, and this call gave text that isn\'t JSON: "{\\"steps\\": 1".', why: 'text that isn\'t JSON, shown' },
  { marker: '', says: 'Nothing was done: probe--move its arguments were cut off before any arrived; call it again with them whole.', why: 'a call cut off before any arguments arrived' },
  { marker: '[1,2]', says: 'Nothing was done: probe--move its input must be an object, and this call gave an array.', why: 'an array' },
  { marker: '5', says: 'Nothing was done: probe--move its input must be an object, and this call gave a number.', why: 'a number' },
  { marker: '"steps"', says: 'Nothing was done: probe--move its input must be an object, and this call gave a string.', why: 'a string' },
  { marker: 'true', says: 'Nothing was done: probe--move its input must be an object, and this call gave a boolean.', why: 'a boolean' },
  { marker: '{"steps":5}', says: 'Nothing was done: probe--move its arguments came in a response whose parts arrived out of order, so they may not be this call\'s; call it again.', why: 'an object from a stream that broke the block order' },
];

for (const { marker, says, why } of refusals) {
  test(`a model's call that membrane marks with ${why} doesn't run, and the model is told why`, async () => {
    const h = await harness();
    try {
      const results = await h.turn([marked(marker)]);
      assert.deepEqual(h.effects, [], 'the tool never ran');
      assert.equal(results.length, 1, 'the turn went on with a result for the call');
      assert.equal(results[0]!.isError, true);
      assert.equal(results[0]!.content, says);
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

test('a call marked as JSON null runs as a call with no arguments, and an unmarked call runs as it came', async () => {
  for (const marker of ['null', undefined]) {
    const h = await harness();
    try {
      const results = await h.turn([marked(marker)]);
      assert.deepEqual(h.effects.map((call) => call.input), [{}], `marker ${String(marker)}: the tool ran once with no arguments`);
      assert.equal(results[0]!.isError, false);
    } finally { await h.close(); }
  }
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
    assert.match(results[0]!.content, /^Nothing was done: code_execution its arguments came in a response whose parts arrived out of order/);
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
    assert.deepEqual(h.effects, []);
    const traced = h.traces.filter((e) => e.callId === 'programmatic' && e.type === 'tool:failed');
    assert.equal(traced.length, 1, 'the failure is traced once');
  } finally { await h.close(); }
});

test("runInference's tool calls carry membrane's marker", async () => {
  const h = await harness();
  try {
    h.membrane.pushResponse(createMockResponse([marked('[1]')], 'tool_use'));
    const result = await h.framework.getAgent('assistant')!.runInference(h.framework.getAllTools());
    assert.deepEqual(result.toolCalls.map((call) => call.unparseableInput), ['[1]']);
  } finally { await h.close(); }
});

/**
 * A lone UTF-16 surrogate in a tool result's text reaches membrane as U+FFFD,
 * as the context store writes it, so the copy sent and the copy stored match
 * (#695). Each text a result's copies carry is made well formed where it's
 * taken from the result: a text block's text and a reference's stub, in the
 * history converter and the native one, and an error result's text, on the
 * framework's path and the direct Agent API's.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework, type AgentConfig, type Module, type ProcessEvent, type ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const LONE = 'cut \ud83d here';
const MENDED = 'cut \ufffd here';
// A 1×1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const IMAGE = { type: 'image', data: PNG, mimeType: 'image/png' };

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** Each text a tool result's content holds: a string, or its text blocks'. */
function texts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
    ? [(b as { text: string }).text] : []));
}

class Canned implements Module {
  readonly name = 'canned';
  constructor(private readonly result: ToolResult) {}
  async start() {}
  async stop() {}
  getTools() {
    return [{ name: 'fetch', description: 'Returns the canned result.', inputSchema: { type: 'object' as const, properties: {} } }];
  }
  async handleToolCall() { return this.result; }
  async onProcess(event: ProcessEvent) {
    return event.type === 'external-message'
      ? { addMessages: [{ participant: 'user', content: [{ type: 'text' as const, text: 'fetch it' }] }], requestInference: true }
      : {};
  }
}

async function framework(result: ToolResult, membrane: MockMembrane, agent: Partial<AgentConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-well-formed-')); dirs.push(dir);
  return AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all', ...agent }],
    modules: [new Canned(result)],
    syncIntervalMs: 0,
  });
}

function storedToolResult(f: AgentFramework): unknown {
  const blocks = f.getAgent('prime')!.getContextManager().getAllMessages()
    .flatMap((m) => m.content.filter((b) => b.type === 'tool_result'));
  assert.equal(blocks.length, 1, 'one tool result is stored');
  return (blocks[0] as { content: unknown }).content;
}

const SHAPES: Array<[string, ToolResult]> = [
  ['a text block beside an image', { success: true, data: [{ type: 'text', text: LONE }, IMAGE] }],
  ['a text block alone', { success: true, data: [{ type: 'text', text: LONE }] }],
  ['a reference named with it, beside an image', { success: true, data: [{ type: 'resource', uri: 'memo://f417-beside', name: LONE }, IMAGE] }],
  ['a reference named with it, alone', { success: true, data: [{ type: 'resource', uri: 'memo://f417-alone', name: LONE }] }],
  ['a reference named with it as the whole data', { success: true, data: { type: 'resource', uri: 'memo://f417-bare', name: LONE } }],
  ['an error result', { success: false, isError: true, error: LONE }],
  ["a failure the tool doesn't flag as an error", { success: false, error: LONE }],
];

// With the guard on, the guard stores the result, and on main the stored
// message couldn't be read back: the next turn sent nothing and stop() threw.
for (const guard of [false, true]) for (const [shape, result] of SHAPES) {
  test(`a lone surrogate in ${shape} reaches membrane as the stored copy holds it, U+FFFD${guard ? ', with the guard on' : ''}`, async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'call_fetch', name: 'canned--fetch', input: {} }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Handled.' }]));
    const f = await framework(result, membrane, { toolResultGuard: guard });
    try {
      f.pushEvent({ type: 'external-message', source: 'test', content: 'fetch it', metadata: {} });
      await f.runUntilIdle();
      const sent = (membrane.lastStream?.receivedToolResults[0]?.[0] as { content: unknown } | undefined)?.content;
      assert.ok(sent !== undefined, 'a tool result reached membrane');
      const stored = storedToolResult(f);
      const sentTexts = texts(sent);
      assert.ok(sentTexts.length > 0, 'the result sent carries text');
      for (const t of sentTexts) assert.ok(t.isWellFormed(), `the text sent is well formed: ${JSON.stringify(t)}`);
      assert.ok(sentTexts.some((t) => t.includes(MENDED)), 'the lone half is sent as U+FFFD');
      if (typeof sent === 'string') {
        assert.equal(sent, stored, 'the copy sent is the copy stored');
      } else {
        // Sent as native blocks beside the image: the stored copy is their
        // text, with the image as its placeholder.
        const storedText = texts(stored).join('\n');
        for (const t of sentTexts) assert.ok(storedText.includes(t), `the stored copy holds the text sent: ${JSON.stringify(t)}`);
      }
    } finally {
      await f.stop();
    }
  });
}

/**
 * One round through the direct Agent API: a call answered with `result`,
 * then the next request, whose tool results' content goes to `check`.
 */
async function directRound(result: ToolResult, agentConfig: Partial<AgentConfig>, check: (sent: unknown[], f: AgentFramework) => void) {
  const membrane = new MockMembrane();
  const requests: NormalizedRequest[] = [];
  const unscripted: number[] = [];
  const responses: NormalizedResponse[] = [
    createMockResponse([{ type: 'tool_use', id: 'one', name: 'canned--fetch', input: {} }], 'tool_use'),
    createMockResponse([{ type: 'text', text: 'Handled.' }]),
  ];
  (membrane as unknown as { stream: (request: NormalizedRequest) => Promise<NormalizedResponse> }).stream = async (request) => {
    requests.push(structuredClone(request));
    const response = responses.shift();
    if (!response) {
      unscripted.push(requests.length);
      throw new Error('no more inference than scripted');
    }
    return response;
  };
  const f = await framework({ success: true, data: 'unused' }, membrane, agentConfig);
  try {
    const agent = f.getAgent('prime')!;
    agent.getContextManager().addMessage('user', [{ type: 'text', text: 'fetch it' }]);
    assert.equal((await agent.runInference(f.getAllTools())).toolCalls.length, 1);
    agent.provideToolResult('one', result);
    await agent.runInference(f.getAllTools());
    assert.equal(requests.length, 2);
    const sent = requests[1].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result')
      .map((b) => (b as { content: unknown }).content);
    assert.equal(sent.length, 1, 'the second request carries the tool result');
    check(sent, f);
    assert.deepEqual(unscripted, [], 'every inference the framework asked for was one the test scripted');
  } finally {
    await f.stop();
  }
}

test('a lone surrogate in an error result given through the direct Agent API reaches membrane as U+FFFD, as it is stored', async () => {
  // The guard stores the direct API's results; without it, the caller keeps
  // the context, and nothing is stored to compare with.
  await directRound({ success: false, isError: true, error: LONE }, { toolResultGuard: true }, (sent, f) => {
    assert.equal(sent[0], MENDED, 'the lone half is sent as U+FFFD');
    assert.equal(sent[0], storedToolResult(f), 'the copy sent is the copy stored');
  });
});

test("an error that isn't a string, given through the direct Agent API, is passed on as it was", async () => {
  // That API's results are unchecked: only a string error is made well
  // formed, and any other value goes on as before.
  await directRound({ success: false, isError: true, error: ['not a string'] as unknown as string }, {}, (sent) => {
    assert.deepEqual(sent[0], ['not a string']);
  });
});

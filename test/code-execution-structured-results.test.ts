/**
 * A tool's structured result end to end: a real MCPL connection, the
 * framework's dispatch, and a real Python script. Adapted from
 * anima-research/agent-framework#181's test of the same name, which first
 * found scripts losing structuredContent. Beside what a script reads, it
 * checks that the model's own calls and the stored history keep the readable
 * text, and that a result an in-process module returns but JSON can't hold
 * reaches the script as an error naming the tool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

import { AgentFramework } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const envelope = {
  runId: 'r41', state: 'running', exit: null, nextCursor: 17, truncated: false,
  output: 'café 🌱', details: { retries: 0, lines: ['one', 'two'] },
};
const transcript = 'Readable transcript: work continues.';
const text = (t: string) => [{ type: 'text', text: t }];

/** tools/call results by variant, as an MCPL peer sends them. */
const fixtures: Record<string, unknown> = {
  dual: { content: text(transcript), structuredContent: envelope },
  empty: { content: text('not the empty object'), structuredContent: {} },
  only: { content: [], structuredContent: envelope },
  plain: { content: text('plain text') },
  absent: { content: [] },
  error: { content: text('run refused'), structuredContent: { state: 'rejected' }, isError: true },
  large: { content: text('short rendering'), structuredContent: { output: 'x'.repeat(5_000_000) } },
};

/** An in-process module whose results JSON can't hold. */
class UnconvertibleModule implements Module {
  readonly name = 'loop';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  async onProcess(): Promise<EventResponse> { return {}; }
  getTools(): ToolDefinition[] {
    return ['cyclic', 'bigint', 'cyclic_data', 'cyclic_error', 'bare_throw'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const name = call.name.includes('--') ? call.name.slice(call.name.lastIndexOf('--') + 2) : call.name;
    const cyclic: Record<string, unknown> = { kind: 'loop' };
    cyclic.self = cyclic;
    if (name === 'cyclic') return { success: true, data: text('a loop'), structured: cyclic };
    if (name === 'bigint') return { success: true, data: text('a big number'), structured: { n: 1n } };
    if (name === 'cyclic_error') return { success: false, isError: true, error: 'db timeout', data: text('failed'), structured: cyclic };
    // A toJSON that throws a value with no prototype, so String() can't describe it either.
    if (name === 'bare_throw') return { success: true, data: text('bare'), structured: { toJSON() { throw Object.create(null); } } };
    return { success: true, data: cyclic };
  }
}

test("a script reads a structured result whole, the model's calls and history keep the readable text, and a result JSON can't hold is an error naming the tool", async () => {
  const calls: string[] = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    if (msg.method === 'initialize') {
      reply({
        protocolVersion: '2024-11-05', serverInfo: { name: 'fixture', version: '1.0.0' },
        capabilities: { tools: {}, experimental: { mcpl: { version: '0.4', pushEvents: true } } },
      });
    } else if (msg.method === 'featureSets/update') {
      reply({});
    } else if (msg.method === 'tools/list') {
      reply({ tools: [{ name: 'inspect', description: 'Read work status', inputSchema: { type: 'object' } }] });
    } else if (msg.method === 'tools/call') {
      calls.push(msg.params.arguments.variant);
      reply(fixtures[msg.params.arguments.variant]);
    }
  }));
  if (!wss.address()) await new Promise<void>((resolve) => wss.once('listening', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'pytc-structured-'));
  const membrane = new MockMembrane();
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
      agents: [], modules: [new UnconvertibleModule()], syncIntervalMs: 0, codeExecution: { enabled: true },
      mcplServers: [{ id: 'fixture', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, toolPrefix: 'fixture' }],
    });
    await framework.start();
    for (let i = 0; i < 100 && !framework.getAllTools().some((t) => t.name === 'fixture--inspect'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // The promise-based path, which modules and outside callers use, carries
    // both views.
    const direct = await framework.executeToolCall({ id: 'direct-api', name: 'fixture--inspect', input: { variant: 'dual' } });
    assert.deepEqual(direct.data, text(transcript));
    assert.deepEqual(direct.structured, envelope);

    const code = [
      'import json',
      `ENVELOPE = json.loads(${JSON.stringify(JSON.stringify(envelope))})`,
      `TRANSCRIPT = ${JSON.stringify(transcript)}`,
      'r = json.loads(await fixture__inspect({"variant": "dual"}))',
      'assert r == {"content": [{"type": "text", "text": TRANSCRIPT}], "structuredContent": ENVELOPE, "isError": False}, r',
      'empty = json.loads(await fixture__inspect({"variant": "empty"}))',
      'assert empty["structuredContent"] == {} and empty["content"] == [{"type": "text", "text": "not the empty object"}], empty',
      'only = json.loads(await fixture__inspect({"variant": "only"}))',
      'assert only == {"content": [], "structuredContent": ENVELOPE, "isError": False}, only',
      // Without structured content, a result is the text it always was.
      'plain = await fixture__inspect({"variant": "plain"})',
      'assert plain == json.dumps("plain text"), plain',
      'absent = await fixture__inspect({"variant": "absent"})',
      'assert absent == "", absent',
      'error = json.loads(await fixture__inspect({"variant": "error"}))',
      'assert error == {"content": [{"type": "text", "text": "run refused"}], "structuredContent": {"state": "rejected"}, "isError": True, "error": "run refused"}, error',
      // Over the cap, with no workspace to save it to: a failure, never a success missing its result.
      'large = json.loads(await fixture__inspect({"variant": "large"}))',
      'assert large["isError"] is True and large["oversized"]["savedTo"] is None and large["oversized"]["chars"] > 5000000, large',
      'assert "could not be delivered" in large["error"], large',
      // Results JSON can't hold: the dispatch makes each an error naming the
      // tool (a module's result has to be stored), which a script reads as
      // its error text, structured or not.
      'cyclic = await loop__cyclic({})',
      'assert cyclic.startswith("Error: Tool \'loop--cyclic\' ") and "circular" in cyclic, cyclic',
      'bigint = await loop__bigint({})',
      'assert bigint.startswith("Error: Tool \'loop--bigint\' ") and "BigInt" in bigint, bigint',
      'cyclic_data = await loop__cyclic_data({})',
      'assert cyclic_data.startswith("Error: Tool \'loop--cyclic_data\' ") and "circular" in cyclic_data, cyclic_data',
      'assert all(e.endswith("The call itself completed.") for e in [cyclic, bigint, cyclic_data]), "completed"',
      // An error result that can't be converted keeps the tool's own error.
      'cyclic_error = await loop__cyclic_error({})',
      'assert cyclic_error.endswith("The call itself completed, with this error: db timeout"), cyclic_error',
      'bare_throw = await loop__bare_throw({})',
      'assert "(a value with no text form)" in bare_throw, bare_throw',
      'print(r["structuredContent"]["runId"], r["structuredContent"]["state"], r["structuredContent"]["output"])',
    ].join('\n');
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'model-direct', name: 'fixture--inspect', input: { variant: 'dual' } },
      { type: 'tool_use', id: 'model-only', name: 'fixture--inspect', input: { variant: 'only' } },
      { type: 'tool_use', id: 'model-python', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    const created = await framework.createEphemeralAgent({ name: 'worker', model: 'test-model', systemPrompt: 'Inspect work.', allowedTools: 'all' });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    await framework.runEphemeralToCompletion(created.agent, created.contextManager);

    const results = membrane.lastStream!.receivedToolResults.flat() as Array<{ toolUseId: string; content: string }>;
    const resultOf = (id: string) => results.find((r) => r.toolUseId === id)!.content;
    // The model reads the content: the text when there is some, and the
    // structured JSON only when the content has none.
    assert.equal(resultOf('model-direct'), JSON.stringify(transcript));
    assert.match(resultOf('model-only'), /\\"runId\\":\\"r41\\"/);
    assert.equal(resultOf('model-python'), 'exit code: 0\n--- stdout ---\nr41 running café 🌱\n');
    assert.deepEqual(calls, ['dual', 'dual', 'only', 'dual', 'empty', 'only', 'plain', 'absent', 'error', 'large']);

    // The stored history holds what the model read: the readable direct
    // result and the script's chosen stdout, never the script's intermediate
    // results.
    const stored = created.contextManager.getAllMessages().flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_result') as unknown as Array<{ toolUseId: string; content: string }>;
    const storedOf = (id: string) => JSON.stringify(stored.find((b) => b.toolUseId === id)!.content);
    assert.ok(storedOf('model-direct').includes('Readable transcript'));
    assert.ok(!storedOf('model-direct').includes('nextCursor'));
    assert.ok(!storedOf('model-python').includes('nextCursor'));
    assert.ok(!storedOf('model-python').includes('short rendering'));
    assert.ok(!storedOf('model-python').includes('structuredContent'));
  } finally {
    await framework?.stop();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

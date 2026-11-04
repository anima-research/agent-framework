/**
 * A tool's structured result end to end: a real MCPL connection, the
 * framework's dispatch, and a real script on the engine. Adapted from
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
    return ['cyclic', 'bigint', 'cyclic_data', 'cyclic_error', 'bare_throw', 'falsy_false', 'falsy_zero', 'falsy_null'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));
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
    // Structured views that are values though they're falsy: kept because they're present.
    if (name === 'falsy_false') return { success: true, data: text('falsy'), structured: false };
    if (name === 'falsy_zero') return { success: true, data: text('falsy'), structured: 0 };
    if (name === 'falsy_null') return { success: true, data: text('falsy'), structured: null };
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
  const dir = mkdtempSync(join(tmpdir(), 'script-structured-'));
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
      'const check = (ok, what, value) => { if (!ok) throw new Error(what + ": " + JSON.stringify(value).slice(0, 500)); };',
      'const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);',
      `const ENVELOPE = ${JSON.stringify(envelope)};`,
      `const TRANSCRIPT = ${JSON.stringify(transcript)};`,
      'const r = await tools["fixture--inspect"]({ variant: "dual" });',
      'check(same(r, { content: [{ type: "text", text: TRANSCRIPT }], structuredContent: ENVELOPE, isError: false }), "dual", r);',
      'const empty = await tools["fixture--inspect"]({ variant: "empty" });',
      'check(same(empty.structuredContent, {}) && same(empty.content, [{ type: "text", text: "not the empty object" }]), "empty", empty);',
      'const only = await tools["fixture--inspect"]({ variant: "only" });',
      'check(same(only, { content: [], structuredContent: ENVELOPE, isError: false }), "only", only);',
      // Without structured content, a result is one text block of the
      // model's text, which for a text result is that text, and no structured view.
      'const plain = await tools["fixture--inspect"]({ variant: "plain" });',
      'check(same(plain, { content: [{ type: "text", text: "plain text" }], structuredContent: null, isError: false }), "plain", plain);',
      'const absent = await tools["fixture--inspect"]({ variant: "absent" });',
      'check(same(absent, { content: [{ type: "text", text: "" }], structuredContent: null, isError: false }), "absent", absent);',
      'const error = await tools["fixture--inspect"]({ variant: "error" });',
      'check(same(error, { content: [{ type: "text", text: "run refused" }], structuredContent: { state: "rejected" }, isError: true }), "error", error);',
      // Past main's old 5 MB cap: whole, within the script's memory bound.
      'const large = await tools["fixture--inspect"]({ variant: "large" });',
      'check(large.isError === false && large.structuredContent.output.length === 5000000, "large", large.isError);',
      // Results JSON can't hold: the dispatch makes each an error naming the
      // tool (a module's result has to be stored), which a script reads as
      // its error text, structured or not.
      'const errorText = async (name) => { const e = await tools[name]({}); check(e.isError === true, name + " is an error", e); return e.content[0].text; };',
      'const cyclic = await errorText("loop--cyclic");',
      // The runtime's own words for a cycle: "circular" under Node, "cyclic" under Bun.
      'check(cyclic.startsWith("Tool \'loop--cyclic\' ") && /circular|cyclic/i.test(cyclic), "cyclic", cyclic);',
      'const bigint = await errorText("loop--bigint");',
      'check(bigint.startsWith("Tool \'loop--bigint\' ") && bigint.includes("BigInt"), "bigint", bigint);',
      'const cyclicData = await errorText("loop--cyclic_data");',
      'check(cyclicData.startsWith("Tool \'loop--cyclic_data\' ") && /circular|cyclic/i.test(cyclicData), "cyclic_data", cyclicData);',
      'check([cyclic, bigint, cyclicData].every((e) => e.endsWith("The call itself completed.")), "completed", null);',
      // An error result that can't be converted keeps the tool's own error.
      'const cyclicError = await errorText("loop--cyclic_error");',
      'check(cyclicError.endsWith("The call itself completed, with this error: db timeout"), "cyclic_error", cyclicError);',
      'const bareThrow = await errorText("loop--bare_throw");',
      'check(bareThrow.includes("(a value with no text form)"), "bare_throw", bareThrow);',
      'for (const [name, value] of [["loop--falsy_false", false], ["loop--falsy_zero", 0], ["loop--falsy_null", null]]) { const f = await tools[name]({}); check(f.structuredContent === value && f.content.length === 1 && f.isError === false, name, f); }',
      'text(r.structuredContent.runId + " " + r.structuredContent.state + " " + r.structuredContent.output);',
    ].join('\n');
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'model-direct', name: 'fixture--inspect', input: { variant: 'dual' } },
      { type: 'tool_use', id: 'model-only', name: 'fixture--inspect', input: { variant: 'only' } },
      { type: 'tool_use', id: 'model-script', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    const created = await framework.createEphemeralAgent({ name: 'worker', model: 'test-model', systemPrompt: 'Inspect work.', allowedTools: 'all' });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    await framework.runEphemeralToCompletion(created.agent, created.contextManager);

    const results = membrane.lastStream!.receivedToolResults.flat() as Array<{ toolUseId: string; content: string }>;
    const resultOf = (id: string) => results.find((r) => r.toolUseId === id)!.content;
    // The model reads the content: the text when there is some, and the
    // structured JSON only when the content has none.
    assert.equal(resultOf('model-direct'), transcript);
    assert.match(resultOf('model-only'), /"runId":"r41"/);
    const script = resultOf('model-script');
    assert.match(script, /^Script \S+ finished\./, script);
    assert.ok(script.endsWith('Its output:\nr41 running café 🌱\n'), script);
    assert.deepEqual(calls, ['dual', 'dual', 'only', 'dual', 'empty', 'only', 'plain', 'absent', 'error', 'large']);

    // The stored history holds what the model read: the readable direct
    // result and the script's chosen stdout, never the script's intermediate
    // results.
    const stored = created.contextManager.getAllMessages().flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_result') as unknown as Array<{ toolUseId: string; content: string }>;
    const storedOf = (id: string) => JSON.stringify(stored.find((b) => b.toolUseId === id)!.content);
    assert.ok(storedOf('model-direct').includes('Readable transcript'));
    assert.ok(!storedOf('model-direct').includes('nextCursor'));
    assert.ok(!storedOf('model-script').includes('nextCursor'));
    assert.ok(!storedOf('model-script').includes('short rendering'));
    assert.ok(!storedOf('model-script').includes('structuredContent'));
  } finally {
    await framework?.stop();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Exercise the whole tools/call -> framework event -> real Python boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const envelope = {
  runId: 'r41', state: 'running', exit: null, nextCursor: 17, truncated: false,
  output: 'café 🌱', details: { retries: 0, lines: ['one', 'two'] },
};
const transcript = 'Readable transcript: work continues.';
const content = (text: string) => [{ type: 'text', text }];

test('structured results reach Python; model calls keep readable content and legacy results keep their shape', async () => {
  const fixtures: Record<string, unknown> = {
    dual: { content: content(transcript), structuredContent: envelope },
    empty: { content: content('not the empty object'), structuredContent: {} },
    only: { content: [], structuredContent: envelope },
    legacy: { content: content('legacy text') },
    absent: { content: [] },
    error: { content: content('run refused'), structuredContent: { state: 'rejected' }, isError: true },
    large: { content: content('short rendering'), structuredContent: { output: 'x'.repeat(5_000_000) } },
  };
  const calls: string[] = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    if (msg.method === 'initialize') {
      reply({ capabilities: { experimental: { mcpl: { version: '0.4', pushEvents: true } } } });
    } else if (msg.method === 'featureSets/update') {
      reply({});
    } else if (msg.method === 'tools/list') {
      reply({ tools: [{ name: 'inspect', description: 'Read work status', inputSchema: { type: 'object' } }] });
    } else if (msg.method === 'tools/call') {
      const variant = msg.params.arguments.variant;
      calls.push(variant);
      reply(fixtures[variant]);
    }
  }));
  if (!wss.address()) await new Promise<void>((resolve) => wss.once('listening', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'pytc-structured-'));
  const membrane = new MockMembrane();
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
      agents: [], modules: [], syncIntervalMs: 0, codeExecution: { enabled: true },
      mcplServers: [{ id: 'fixture', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, toolPrefix: 'fixture' }],
    });

    // The promise-based path is used by ModuleContext.callTool and external
    // callers; it must carry the envelope too, without replacing content.
    const direct = await framework.executeToolCall({ id: 'direct-api', name: 'fixture--inspect', input: { variant: 'dual' } });
    assert.deepEqual(direct.structuredContent, envelope);
    assert.deepEqual(direct.data, content(transcript));

    const code = [
      'import json',
      'r = json.loads(await fixture__inspect({"variant": "dual"}))',
      `assert r == json.loads(${JSON.stringify(JSON.stringify(envelope))})`,
      'assert json.loads(await fixture__inspect({"variant": "empty"})) == {}',
      'assert json.loads(await fixture__inspect({"variant": "only"})) == r',
      // Legacy MCPL text is already a JSON-encoded string. Preserve that
      // exact fallback; structured results do not change other tool calls.
      'assert await fixture__inspect({"variant": "legacy"}) == json.dumps("legacy text")',
      'assert await fixture__inspect({"variant": "absent"}) == ""',
      'assert await fixture__inspect({"variant": "error"}) == "Error: run refused"',
      'large = await fixture__inspect({"variant": "large"})',
      'assert large.startswith("Error:") and "5000000-character" in large and len(large) < 200',
      'print(r["runId"], r["state"], r["output"])',
    ].join('\n');
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'model-direct', name: 'fixture--inspect', input: { variant: 'dual' } },
      { type: 'tool_use', id: 'model-python', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    const created = await framework.createEphemeralAgent({ name: 'worker', model: 'test-model', systemPrompt: 'Inspect work.', allowedTools: 'all' });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    const pending = framework.runEphemeralToCompletion(created.agent, created.contextManager);
    framework.start();
    await pending;

    const results = membrane.lastStream!.receivedToolResults.flat() as Array<{ toolUseId: string; content: string }>;
    const modelDirect = results.find((r) => r.toolUseId === 'model-direct')!;
    assert.equal(modelDirect.content, JSON.stringify(transcript));
    assert.ok(!modelDirect.content.includes('nextCursor'));
    const python = JSON.parse(results.find((r) => r.toolUseId === 'model-python')!.content);
    assert.equal(python.return_code, 0, python.stderr);
    assert.equal(python.stdout.trim(), 'r41 running café 🌱');
    assert.equal(python.stderr, '');
    assert.equal(calls.length, 9, 'two direct calls and seven inner calls');

    // Persisted model history also receives only the readable direct result
    // and the script's selected stdout, never the intermediate envelopes.
    const stored = created.contextManager.getAllMessages().flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_result');
    const history = JSON.stringify(stored);
    assert.ok(history.includes('Readable transcript'));
    assert.ok(!history.includes('nextCursor'));
    assert.ok(!history.includes('short rendering'));
  } finally {
    await framework?.stop();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('module structured results use JSON serialization and respect the existing script cap', async () => {
  // Isolate serialization at the framework boundary for values that cannot
  // arrive on a JSON transport, but can be returned by an in-process module.
  const fw = Object.create(AgentFramework.prototype) as {
    dispatchScriptToolCall: () => Promise<unknown>;
    handleScriptToolCall: (agent: string, tool: string, args: object) => Promise<string>;
  };
  let structuredContent: unknown;
  fw.dispatchScriptToolCall = async () => ({ success: true, structuredContent });
  const invoke = () => fw.handleScriptToolCall('test', 'module--tool', {});

  // An array shaped like MCP content is data here, not a rendering request.
  structuredContent = { blocks: [{ type: 'text', text: 'keep this object' }] };
  assert.deepEqual(JSON.parse(await invoke()), structuredContent);
  // The complete serialized object, including JSON syntax, fits exactly.
  structuredContent = { x: 'x'.repeat(5_000_000 - '{"x":""}'.length) };
  const boundary = await invoke();
  assert.equal(boundary.length, 5_000_000);
  assert.deepEqual(JSON.parse(boundary), structuredContent);
  structuredContent = { x: 'x'.repeat(5_000_000) };
  assert.match(await invoke(), /^Error:.*5000000-character/);
  structuredContent = { cyclic: null };
  (structuredContent as { cyclic: unknown }).cyclic = structuredContent;
  assert.equal(await invoke(), 'Error: tool structuredContent is not JSON-serializable');
  structuredContent = { bigint: 1n };
  assert.equal(await invoke(), 'Error: tool structuredContent is not JSON-serializable');
});

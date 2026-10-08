/**
 * A modern-MCP server inside a real framework (room-284, shelf-487): tool
 * listing and status, both dispatch paths, the script view of structured
 * results, an MCP-only legacy peer read the same standard way, and the host
 * lifetime contract (Tessa #53152, Agnes/Kit #53184, Theo #53178):
 * - a modern call already in flight completes while the host quiesces;
 * - a list change while quiesced refreshes the inventory, and its wake parks
 *   until resume;
 * - a modern child lost while quiesced reconnects and relists without
 *   starting a turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentFramework } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const here = dirname(fileURLToPath(import.meta.url));
const MODERN = join(here, 'fixtures', 'modern-mcp-server.mjs');

/** Turns every external message into a wake, so tool-list diffs wake agents. */
class Waker implements Module {
  readonly name = 'waker';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, error: 'no tools', isError: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }], requestInference: true };
    }
    return {};
  }
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

interface Harness { framework: AgentFramework; membrane: MockMembrane; dir: string }

async function withModern(fn: (h: Harness) => Promise<void>, extraServers: Record<string, unknown>[] = []): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'modern-framework-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [new Waker()],
    mcplServers: [
      {
        id: 'modern',
        command: process.execPath,
        args: [MODERN, join(dir, 'starts.log'), join(dir, 'events.log')],
        protocol: 'modern',
        reconnect: true,
        reconnectIntervalMs: 50,
        reconnectMaxIntervalMs: 100,
      },
      ...(extraServers as never[]),
    ],
  });
  try {
    await fn({ framework, membrane, dir });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const call = (name: string, input: Record<string, unknown> = {}) => ({ id: `t-${name}-${Math.random()}`, name, input });

test('modern tools are listed under the prefix, and status names family, revision and transport', async () => {
  await withModern(async ({ framework }) => {
    const names = framework.getAllTools().map((t) => t.name);
    assert.ok(names.includes('mcpl--modern--echo'), names.join());
    const [status] = framework.listMcplServers();
    assert.equal(status!.family, 'modern');
    assert.equal(status!.protocolVersion, '2026-07-28');
    assert.equal(status!.transport, 'stdio');
    assert.equal(status!.connected, true);
    assert.ok(status!.toolCount >= 5);
    assert.deepEqual(status!.effectiveGrant, []);
  });
});

test('direct path: data stays the raw content; tool errors fail; structured by presence', async () => {
  await withModern(async ({ framework }) => {
    const only = await framework.executeToolCall(call('mcpl--modern--structured_only'));
    assert.equal(only.success, true);
    assert.deepEqual(only.data, [], 'the raw content array, as module callers have always received it');
    assert.deepEqual(only.structured, { answer: 42, ok: false, nothing: null });

    const zero = await framework.executeToolCall(call('mcpl--modern--structured_zero'));
    assert.ok('structured' in zero);
    assert.equal(zero.structured, 0);

    const echo = await framework.executeToolCall(call('mcpl--modern--echo', { text: 'x' }));
    assert.deepEqual(echo, { success: true, data: [{ type: 'text', text: 'echo:x' }] });

    const fail = await framework.executeToolCall(call('mcpl--modern--fail'));
    assert.equal(fail.success, false);
    assert.equal(fail.isError, true);
    assert.equal(fail.error, 'the tool failed on purpose');

    const media = await framework.executeToolCall(call('mcpl--modern--media'));
    assert.deepEqual((media.data as Array<{ type: string }>).map((b) => b.type),
      ['text', 'resource_link', 'resource', 'resource', 'audio', 'image'], 'every block as sent');
  });
});

test('model path: a payload the host cannot retain is reported as an incomplete result', async () => {
  await withModern(async ({ framework, membrane }) => {
    framework.start();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'toolu_01MODERNMEDIA00000000000', name: 'mcpl--modern--media', input: {} },
    ] as never, 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as never);
    await waitFor('the tool round', () => (membrane.lastStream?.receivedToolResults.length ?? 0) >= 1);
    const [delivered] = membrane.lastStream!.receivedToolResults[0] as Array<{ content: unknown; isError: boolean }>;
    // No workspace here: audio and the blob can be neither shown nor kept.
    assert.equal(delivered!.isError, true);
    const text = JSON.stringify(delivered!.content);
    assert.match(text, /result incomplete: 2 payload\(s\) could not be retained/);
    assert.match(text, /resource link \\"report\.pdf\\": file:\/\/\/srv\/report\.pdf, application\/pdf; not fetched/);
    assert.match(text, /embedded note text/);
  });
});

test('model path: the result reaches the model, structured-only as JSON', async () => {
  await withModern(async ({ framework, membrane }) => {
    framework.start();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'toolu_01MODERNSTRUCTURED000000', name: 'mcpl--modern--structured_only', input: {} },
    ] as never, 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as never);
    await waitFor('the tool round', () => (membrane.lastStream?.receivedToolResults.length ?? 0) >= 1);
    // The framework renders string data JSON-encoded, as it does for every
    // string tool result; decoded, it is the structured value's JSON.
    const [delivered] = membrane.lastStream!.receivedToolResults[0] as Array<{ content: string }>;
    assert.deepEqual(JSON.parse(JSON.parse(delivered!.content)), { answer: 42, ok: false, nothing: null });
  });
});

test('scripts get structured results whole, as one JSON object', async () => {
  await withModern(async ({ framework }) => {
    framework.start();
    const handle = (framework as unknown as {
      handleScriptToolCall: (agent: string, tool: string, args: Record<string, unknown>) => Promise<string>;
    }).handleScriptToolCall.bind(framework);
    const out = JSON.parse(await handle('agent', 'mcpl--modern--structured_and_text', {}));
    assert.deepEqual(out, {
      content: [{ type: 'text', text: 'Found 2 rows.' }],
      structuredContent: { rows: [{ id: 1 }, { id: 2 }] },
      isError: false,
    });
    // Image plus scores: both views reach the script whole, the image's
    // payload included (no placeholder stands in for it).
    const scored = JSON.parse(await handle('agent', 'mcpl--modern--scored_image', {}));
    assert.deepEqual(scored, {
      content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
      structuredContent: { score: 0.9, label: 'cat' },
      isError: false,
    });
    // Without structured content the script contract is unchanged (pinned):
    // the history rendering, which JSON-encodes a text result.
    assert.equal(await handle('agent', 'mcpl--modern--echo', { text: 'x' }), JSON.stringify('echo:x'));
  });
});

test('MCPL policy on a modern server is a configuration error at connect', async () => {
  await withModern(async ({ framework }) => {
    await assert.rejects(
      framework.connectMcplServer({ id: 'bad', url: 'https://example.invalid/mcp', enabledFeatureSets: ['x'] }),
      /"enabledFeatureSets" is MCPL policy/,
    );
    await assert.rejects(
      framework.connectMcplServer({ id: 'bad2', url: 'https://example.invalid/mcp', protocol: 'modern' }),
      /applies only to stdio/,
    );
    // Selector combinations that name no usable transport are errors too,
    // not a fall-through to some other opener.
    await assert.rejects(
      framework.connectMcplServer({ id: 'bad3', url: 'https://example.invalid/mcp', transport: 'websocket' }),
      /does not match url/,
    );
    await assert.rejects(
      framework.connectMcplServer({ id: 'bad4', url: 'ws://127.0.0.1:1/mcpl', transport: 'http' }),
      /does not match url/,
    );
    await assert.rejects(
      framework.connectMcplServer({ id: 'bad5', command: process.execPath, transport: 'http' }),
      /transport "http" requires "url"/,
    );
    assert.ok(!framework.listMcplServers().some((s) => s.id.startsWith('bad')), 'nothing registered');
  });
});

test('an MCP-only legacy peer gets the same standard reading', async () => {
  const LEGACY_MCP_ONLY = `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} } });
    else if (m.method === 'tools/list') reply({ tools: [{ name: 'docs', inputSchema: { type: 'object' } }] });
    else if (m.method === 'tools/call') reply({
      content: [
        { type: 'resource_link', uri: 'https://example.invalid/a.md', name: 'a.md' },
        { type: 'resource', resource: { uri: 'memo://n', mimeType: 'text/plain', text: 'note body' } },
      ],
      structuredContent: { count: 2 },
    });
  }
});
`;
  await withModern(async ({ framework, membrane }) => {
    framework.start();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'toolu_01LEGACYDOCS000000000000', name: 'mcpl--plain--docs', input: {} },
    ] as never, 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as never);
    await waitFor('the tool round', () => (membrane.lastStream?.receivedToolResults.length ?? 0) >= 1);
    const [delivered] = membrane.lastStream!.receivedToolResults[0] as Array<{ content: string; isError: boolean }>;
    assert.equal(delivered!.isError, false);
    // No server text block: the structured value is shown beside the stubs.
    assert.equal(JSON.parse(delivered!.content),
      '[resource link "a.md": https://example.invalid/a.md; not fetched]\n[resource memo://n, text/plain]\nnote body\n{"count":2}');
    const status = framework.listMcplServers().find((s) => s.id === 'plain')!;
    assert.equal(status.family, 'legacy');
    assert.equal(status.protocolVersion, '2024-11-05');
  }, [{ id: 'plain', command: process.execPath, args: ['-e', LEGACY_MCP_ONLY] }]);
});

test('quiesce: a modern call already in flight completes, and its result reaches the turn', async () => {
  await withModern(async ({ framework, membrane, dir }) => {
    framework.start();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'toolu_01MODERNSLOW0000000000000', name: 'mcpl--modern--slow', input: { ms: 600 } },
    ] as never, 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as never);
    await waitFor('the slow call to start server-side', () => lines(join(dir, 'events.log')).includes('slow-start'));

    const status = await framework.quiesce({ reason: 'maintenance', timeoutMs: 10_000 });
    assert.equal(status.quiesced, true);
    assert.equal(status.drained, true, 'the turn drained: its modern call completed');
    assert.ok(lines(join(dir, 'events.log')).includes('slow-finished'));
    assert.ok(!lines(join(dir, 'events.log')).includes('slow-aborted'), 'quiesce did not cancel it');
    assert.match(JSON.stringify(membrane.lastStream!.receivedToolResults[0]), /slept 600/);
    await framework.resume();
  });
});

test('quiesce: a list change refreshes the inventory, and its wake parks until resume', async () => {
  await withModern(async ({ framework, membrane }) => {
    framework.start();
    await framework.quiesce({ reason: 'maintenance' });
    const callsBefore = membrane.calls.length;
    const gatedBefore = framework.getHostModeStatus().gatedRequests;

    await framework.executeToolCall(call('mcpl--modern--add_tool'));
    await waitFor('the refreshed inventory', () => framework.getAllTools().some((t) => t.name === 'mcpl--modern--added_1'));
    await waitFor('the wake to park', () => framework.getHostModeStatus().gatedRequests > gatedBefore);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(membrane.calls.length, callsBefore, 'no inference while quiesced');

    await framework.resume();
    await waitFor('the parked wake to run', () => membrane.calls.length > callsBefore);
  });
});

test('quiesce: a lost modern child reconnects and relists without starting a turn', async () => {
  await withModern(async ({ framework, membrane, dir }) => {
    framework.start();
    await framework.quiesce({ reason: 'maintenance' });
    const callsBefore = membrane.calls.length;
    const gatedBefore = framework.getHostModeStatus().gatedRequests;

    await framework.executeToolCall(call('mcpl--modern--die'));
    await waitFor('a second launch', () => lines(join(dir, 'starts.log')).length === 2);
    await waitFor('reconnected', () => framework.listMcplServers()[0]!.connected);
    await waitFor('the relisted inventory', () => framework.getAllTools().some((t) => t.name === 'mcpl--modern--echo'));
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(membrane.calls.length, callsBefore, 'no turn started');
    assert.equal(framework.getHostModeStatus().gatedRequests, gatedBefore, 'no wake parked: the inventory is unchanged');
    assert.deepEqual((await framework.executeToolCall(call('mcpl--modern--echo', { text: 'back' }))).data, [{ type: 'text', text: 'echo:back' }]);
    await framework.resume();
  });
});

test('the framework owns a modern connect in flight: stop() ends it, and a second connect is refused', async () => {
  const RAW = join(here, 'fixtures', 'modern-raw-server.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'modern-framework-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  try {
    const log = join(dir, 'hang.jsonl');
    const config = { id: 'hang', command: process.execPath, args: [RAW, 'hang-discover', log], protocol: 'modern' as const };
    const pending = framework.connectMcplServer(config);
    await waitFor('the launch waiting on discover', () => lines(log).some((l) => l.includes('server/discover')));
    await assert.rejects(framework.connectMcplServer(config), /already registered/);
    const pid = (JSON.parse(lines(log)[0]!) as { pid: number }).pid;
    await framework.stop();
    const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
    assert.equal(alive(pid), false, 'the launch in flight was reaped by stop()');
    await pending.catch(() => {});
    assert.ok(!framework.listMcplServers().some((s) => s.id === 'hang' && s.connected), 'nothing installed after stop');
    // A connect that arrives after stop() is refused before anything spawns.
    const before = lines(log).length;
    await assert.rejects(
      framework.connectMcplServer({ ...config, id: 'late' }),
      /was not connected: the framework is stopping or stopped/,
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(lines(log).length, before, 'no launch after stop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

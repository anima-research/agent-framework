/**
 * A modern-MCP server inside a real framework: tool listing and status, both
 * dispatch paths, the script view of structured results, an MCP-only legacy
 * peer read the same standard way, and the host lifetime contract:
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

import { AgentFramework, WorkspaceModule } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { answerText, scriptCall } from './helpers/script-call.js';

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

async function withModern(
  fn: (h: Harness) => Promise<void>,
  extraServers: Record<string, unknown>[] = [],
  extraModules: Module[] = [],
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'modern-framework-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [new Waker(), ...extraModules],
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
    // That makes the result a failure, read as its text alone, so the inline
    // image is a payload too, and can't be kept either.
    assert.equal(delivered!.isError, true);
    const text = JSON.stringify(delivered!.content);
    assert.match(text, /result incomplete: 3 payload\(s\) could not be retained/);
    assert.match(text, /\[image: image\/png, 8 B\. Not retained: a failed result is read as its text alone, and no workspace is mounted to save it\]/);
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

/** The JSON a script's call gets, parsed: { content, structuredContent, isError }. */
const scriptHandle = (framework: AgentFramework) => async (agent: string, tool: string, args: Record<string, unknown>) => {
  const answer = await (framework as unknown as {
    scriptToolCall: (agent: string, tool: string, argsJson: string, context: object) => Promise<{ ok: boolean; json: string; isError?: boolean }>;
  }).scriptToolCall(agent, tool, JSON.stringify(args), {});
  return { ok: answer.ok, isError: answer.isError === true, value: JSON.parse(answer.json) as unknown };
};

const sizedObject = (pad: number, isError = false) => ({
  // A tool error with no text reads as the framework's own error text, as
  // the model's dispatch words it.
  content: isError
    ? [{
        type: 'text',
        text: 'The "modern" server reported an error for mcpl--modern--sized without saying what went wrong. ' +
          'Whether it did anything is unknown: check before calling it again.',
      }]
    : [],
  structuredContent: { pad: 'x'.repeat(pad) },
  isError,
});

test('scripts get every result in one shape, structured results whole', async () => {
  await withModern(async ({ framework }) => {
    framework.start();
    const handle = scriptHandle(framework);
    // Beside the object: isError, which the runner records the call by.
    assert.deepEqual(await handle('agent', 'mcpl--modern--structured_and_text', {}), {
      ok: true,
      isError: false,
      value: {
        content: [{ type: 'text', text: 'Found 2 rows.' }],
        structuredContent: { rows: [{ id: 1 }, { id: 2 }] },
        isError: false,
      },
    });
    // A structured tool error is flagged as one, its text in content.
    assert.deepEqual(await handle('agent', 'mcpl--modern--sized', { pad: 1, isError: true }), { ok: true, isError: true, value: sizedObject(1, true) });
    // Image plus scores: both views reach the script whole, the image's
    // payload included (no placeholder stands in for it).
    assert.deepEqual((await handle('agent', 'mcpl--modern--scored_image', {})).value, {
      content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
      structuredContent: { score: 0.9, label: 'cat' },
      isError: false,
    });
    // A resource link, embedded resources and audio are ordinary MCP blocks
    // from a modern server, not RFC-005 references: the script reads them as
    // the server sent them.
    assert.deepEqual((await handle('agent', 'mcpl--modern--structured_media', {})).value, {
      content: [
        { type: 'text', text: 'before' },
        { type: 'resource_link', uri: 'file:///srv/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' },
        { type: 'resource', resource: { uri: 'memo://note', mimeType: 'text/plain', text: 'embedded note text' } },
        { type: 'resource', resource: { uri: 'memo://bin', mimeType: 'application/octet-stream', blob: Buffer.from('binary!').toString('base64') } },
        { type: 'audio', data: Buffer.from('RIFF0000WAVEfmt ').toString('base64'), mimeType: 'audio/wav' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ],
      structuredContent: { blocks: 6 },
      isError: false,
    });
    // Without structured content, content is the model's text: the history
    // rendering, which JSON-encodes a text result. structuredContent is null.
    assert.deepEqual(await handle('agent', 'mcpl--modern--echo', { text: 'x' }), {
      ok: true,
      isError: false,
      value: { content: [{ type: 'text', text: JSON.stringify('echo:x') }], structuredContent: null, isError: false },
    });
  });
});

/** A saved file's bytes, read back through the workspace as a resident would. */
async function readSaved(workspace: WorkspaceModule, path: string): Promise<string> {
  const read = await workspace.readBinary(path);
  assert.ok('data' in read, `readable: ${path} (${'error' in read ? read.error : ''})`);
  return read.data.toString('utf8');
}

async function withWorkspace(fn: (h: Harness & { workspace: WorkspaceModule }) => Promise<void>): Promise<void> {
  const board = mkdtempSync(join(tmpdir(), 'modern-board-'));
  const workspace = new WorkspaceModule({ mounts: [{ name: 'board', path: board, mode: 'read-write', watch: 'never' }] });
  try {
    await withModern((h) => {
      // The host wires the store after create(), as conhost does.
      workspace.initStore(h.framework.getStore());
      return fn({ ...h, workspace });
    }, [], [workspace]);
  } finally {
    rmSync(board, { recursive: true, force: true });
  }
}

test("a script's result past main's old 5 MB cap reaches it whole, and nothing is saved to the workspace", async () => {
  await withWorkspace(async ({ framework, workspace }) => {
    framework.start();
    let writes = 0;
    const write = workspace.writeBinary.bind(workspace);
    workspace.writeBinary = async (...args: Parameters<typeof write>) => {
      writes += 1;
      return write(...args);
    };
    const pad = 5_000_001;
    assert.deepEqual(await scriptHandle(framework)('agent', 'mcpl--modern--sized', { pad }), { ok: true, isError: false, value: sizedObject(pad) });
    assert.deepEqual(await scriptHandle(framework)('agent', 'mcpl--modern--sized', { pad, isError: true }), { ok: true, isError: true, value: sizedObject(pad, true) });
    assert.equal(writes, 0, 'no spill: a result too large for the script is refused as ResultTooLarge in the runner instead');
  });
});

test('saved payloads: call ids that sanitize to one label still get distinct files', async () => {
  await withWorkspace(async ({ framework, workspace }) => {
    const read = (framework as unknown as {
      mcpToolResult: (result: unknown, callId: string, mcplPeer: boolean) => Promise<ToolResult>;
    }).mcpToolResult.bind(framework);
    const audio = (bytes: string) => ({ content: [{ type: 'audio', data: Buffer.from(bytes).toString('base64'), mimeType: 'audio/wav' }] });
    const savedTo = (result: ToolResult) => /saved to workspace file (\S+)\]/.exec(String(result.data))?.[1];
    // `call:a` and `call/a` sanitize alike; so do ids that differ only past the kept prefix.
    const long = 'x'.repeat(90);
    const results = [
      await read(audio('first'), 'call:a', false),
      await read(audio('second'), 'call/a', false),
      await read(audio('third'), `${long}-1`, false),
      await read(audio('fourth'), `${long}-2`, false),
    ];
    const paths = results.map(savedTo);
    assert.ok(paths.every((p) => typeof p === 'string'), JSON.stringify(results));
    assert.equal(new Set(paths).size, 4, `distinct paths: ${paths.join(', ')}`);
    assert.deepEqual(
      await Promise.all(paths.map((p) => readSaved(workspace, p!))),
      ['first', 'second', 'third', 'fourth'],
      'each file keeps its own call\'s bytes',
    );
  });
});

test("a payload whose workspace write rejects is lost from a completed call's result, with why logged, not a dispatch failure", async (t) => {
  await withWorkspace(async ({ framework, workspace }) => {
    const read = (framework as unknown as {
      mcpToolResult: (result: unknown, callId: string, mcplPeer: boolean) => Promise<ToolResult>;
    }).mcpToolResult.bind(framework);
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    });
    const clip = { content: [{ type: 'audio', data: Buffer.from('clip').toString('base64'), mimeType: 'audio/wav' }] };

    workspace.writeBinary = async () => { throw new Error('disk gone'); };
    const rejected = await read(clip, 'call-1', false);
    assert.equal(rejected.success, false);
    assert.match(rejected.error!, /saving it to the workspace failed\]/);

    workspace.writeBinary = async () => ({ success: false, error: 'disk full', isError: true });
    const refused = await read(clip, 'call-2', false);
    assert.equal(refused.success, false);
    assert.match(refused.error!, /saving it to the workspace failed\]/);

    const saves = logged.filter((line) => line.startsWith('[mcp] saving tool payload'));
    assert.equal(saves.length, 2, logged.join('\n'));
    assert.match(saves[0]!, /^\[mcp\] saving tool payload board\/tool-results\/\S+\.wav \("audio\/wav"\) failed: disk gone$/);
    assert.match(saves[1]!, /^\[mcp\] saving tool payload board\/tool-results\/\S+\.wav \("audio\/wav"\) failed: disk full$/);
  });
});

test('a modern server deployed with a host\'s MCPL deny-list connects, since what only narrows is already satisfied (R1-3)', async () => {
  await withModern(async ({ framework, dir }) => {
    await framework.connectMcplServer({
      id: 'overlay',
      command: process.execPath,
      args: [MODERN, join(dir, 'overlay-starts.log'), join(dir, 'overlay-events.log')],
      protocol: 'modern',
      // connectome-host's overlay route stamps this on every server it deploys.
      disabledCapabilities: ['contextHooks', 'inferenceLifecycle', 'inferenceRequest', 'toolLifecycle'],
      disabledFeatureSets: ['*'],
    });
    const status = framework.listMcplServers().find((s) => s.id === 'overlay');
    assert.equal(status?.connected, true);
    assert.equal(status?.family, 'modern');
    assert.ok(framework.getAllTools().some((t) => t.name === 'mcpl--overlay--echo'));
  });
});

test('MCPL policy on a modern server is a configuration error at connect', async () => {
  await withModern(async ({ framework }) => {
    await assert.rejects(
      framework.connectMcplServer({ id: 'bad', url: 'https://example.invalid/mcp', allowHostCommands: true }),
      /"allowHostCommands" asks for MCPL behaviour/,
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
      { type: 'tool_use', id: 'toolu_01MODERNSLOW0000000000000', name: 'mcpl--modern--slow', input: { ms: 1500 } },
    ] as never, 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as never);
    await waitFor('the slow call to start server-side', () => lines(join(dir, 'events.log')).includes('slow-start'));

    // Quiesce begins while the call is provably still running server-side,
    // so its resolving after 'slow-finished' shows it waited for the call.
    const quiescing = framework.quiesce({ reason: 'maintenance', timeoutMs: 10_000 });
    assert.ok(!lines(join(dir, 'events.log')).includes('slow-finished'), 'the call is still in flight as quiesce begins');
    const status = await quiescing;
    assert.equal(status.quiesced, true);
    assert.equal(status.drained, true, 'the turn drained: its modern call completed');
    assert.ok(lines(join(dir, 'events.log')).includes('slow-finished'));
    assert.ok(!lines(join(dir, 'events.log')).includes('slow-aborted'), 'quiesce did not cancel it');
    assert.match(JSON.stringify(membrane.lastStream!.receivedToolResults[0]), /slept 1500/);
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

test("the framework owns a modern connect in flight: a second connect is refused in #506's words, a tool call reads the connecting text, and stop() ends it", async () => {
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
    await assert.rejects(framework.connectMcplServer(config), /^Error: MCPL server "hang" has a connect in flight; try again once it settles$/);
    // Its connection is registered before it starts, and not one to call yet.
    const during = await framework.executeToolCall({ id: 'during', name: 'mcpl--hang--echo', input: {} });
    assert.equal(during.success, false);
    assert.equal(during.error, 'This host is connecting to the "hang" server that provides mcpl--hang--echo, so the call didn\'t run. Try again in a moment.');
    assert.equal(lines(log).filter((l) => l.includes('tools/call')).length, 0, 'nothing reached the server');
    const pid = (JSON.parse(lines(log)[0]!) as { pid: number }).pid;
    // stop() ends the connect in flight rather than waiting for its handshake.
    const stopping = Date.now();
    await framework.stop();
    assert.ok(Date.now() - stopping < 10_000, `stop() took ${Date.now() - stopping} ms, as if it waited out the connect`);
    const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
    assert.equal(alive(pid), false, 'the launch in flight was reaped by stop()');
    await pending.catch(() => {});
    assert.ok(!framework.listMcplServers().some((s) => s.id === 'hang' && s.connected), 'nothing installed after stop');
    // A connect that arrives after stop() is refused before anything spawns.
    const before = lines(log).length;
    await assert.rejects(
      framework.connectMcplServer({ ...config, id: 'late' }),
      /connect MCPL server refused: the framework is stopping/,
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(lines(log).length, before, 'no launch after stop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lost modern child is relisted from the new launch: what only the old one listed is gone', async () => {
  await withModern(async ({ framework, dir }) => {
    framework.start();
    // The first launch registers a tool at runtime; a fresh launch won't have it.
    await framework.executeToolCall(call('mcpl--modern--add_tool'));
    await waitFor('the first launch\'s added tool', () => framework.getAllTools().some((t) => t.name === 'mcpl--modern--added_1'));
    await framework.executeToolCall(call('mcpl--modern--die'));
    await waitFor('a second launch', () => lines(join(dir, 'starts.log')).length === 2);
    await waitFor('the relist from the new launch', () =>
      framework.listMcplServers()[0]!.connected
      && framework.getAllTools().some((t) => t.name === 'mcpl--modern--echo')
      && !framework.getAllTools().some((t) => t.name === 'mcpl--modern--added_1'));
  });
});

test("a modern tool's error result is traced as tool:failed, not tool:completed", async () => {
  const traces: Array<{ type: string; tool?: string; error?: string }> = [];
  const watcher: Module = {
    name: 'trace-watcher',
    async start(ctx: ModuleContext) { ctx.onTrace((event) => traces.push(event as never)); },
    async stop() {},
    getTools: (): ToolDefinition[] => [],
    handleToolCall: async (): Promise<ToolResult> => ({ success: false, error: 'no tools', isError: true }),
    onProcess: async () => ({}),
  };
  await withModern(async ({ framework, membrane }) => {
    framework.start();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'toolu_01MODERNFAIL0000000000000', name: 'mcpl--modern--fail', input: {} },
    ] as never, 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Noted.' }]));
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as never);
    await waitFor('the tool trace', () => traces.some((t) => (t.type === 'tool:failed' || t.type === 'tool:completed') && t.tool === 'fail'));
    const outcome = traces.find((t) => (t.type === 'tool:failed' || t.type === 'tool:completed') && t.tool === 'fail')!;
    assert.equal(outcome.type, 'tool:failed');
    assert.match(outcome.error ?? '', /the tool failed on purpose/);
  }, [], [watcher]);
});

test("a call whose request couldn't be written is a failure saying it wasn't sent, on the direct path and the dispatch path", async () => {
  // The raw server's tool advertises an outputSchema the SDK can't compile, so
  // the SDK rejects the call before sending it (McplRequestError, not-sent).
  // The call had opened (RFC-007), so it's no refusal (ToolResult.refused).
  const RAW = join(here, 'fixtures', 'modern-raw-server.mjs');
  const log = join(mkdtempSync(join(tmpdir(), 'modern-raw-')), 'raw.jsonl');
  await withModern(async ({ framework }) => {
    await waitFor('the raw server\'s tool', () => framework.getAllTools().some((t) => t.name === 'mcpl--raw--op'));
    const direct = await framework.executeToolCall(call('mcpl--raw--op'));
    assert.equal(direct.refused, undefined, JSON.stringify(direct));
    assert.equal(direct.isError, true);
    // The words for a request that couldn't be written, not those for a closed connection's.
    assert.match(direct.error ?? '', /The request wasn't sent: this host couldn't send it to/);
    const pending = scriptCall(framework, 'agent', 'mcpl--raw--op');
    const processing = setInterval(() => { void framework.runUntilIdle(); }, 5);
    try {
      const dispatched = await pending;
      assert.equal(dispatched.refused, false, JSON.stringify(dispatched));
      assert.equal(dispatched.refused ? null : dispatched.isError, true);
      assert.match(answerText(dispatched), /The request wasn't sent: this host couldn't send it to/);
    } finally {
      clearInterval(processing);
    }
  }, [{ id: 'raw', command: process.execPath, args: [RAW, 'invalid-schema', log], protocol: 'modern' }]);
});

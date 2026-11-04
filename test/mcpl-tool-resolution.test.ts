/**
 * A programmatic call of a namespaced MCPL tool, through the public
 * executeToolCall or a module's ctx.callTool, reaches the server the model's
 * own call reaches, through resolveMcplTool, and sends it the tool name the
 * model's call sends; a call a server's policy denies is sent on no path, and
 * a name no MCPL prefix fits goes to the module registry. A server's close
 * forgets the RFC-008 class declarations of its own tools.
 */

import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import type { Module, ModuleContext, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tool-listing-mcpl-server.mjs');

/** Hands the test its context, and has one tool of its own, `ctx-capture--ping`. */
class CtxCaptureModule implements Module {
  readonly name = 'ctx-capture';
  ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> { this.ctx = null; }
  getTools(): ToolDefinition[] { return [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }]; }
  async handleToolCall(call: ToolCall): Promise<ToolResult> { return { success: true, data: `module:${call.name}` }; }
  async onProcess(): Promise<Record<string, never>> { return {}; }
}

interface Internals {
  mcplServerRegistry: unknown;
  mcplServerConfigs: Map<string, Record<string, unknown>>;
  mcplPrefixMap: Map<string, string>;
  refreshMcplTools(): Promise<void>;
  dispatchToolCall(agentName: string, call: ToolCall): void;
  wireMcplEvents(connection: unknown, config: unknown): void;
}

/** The three ways a call reaches dispatch: the model's own, and the two programmatic ones. */
const PATHS = ['model', 'executeToolCall', 'ctx.callTool'] as const;
type Path = typeof PATHS[number];

async function framework(extra: Record<string, unknown> = {}, agent: Record<string, unknown> = {}, modules: Module[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'af-mcpl-resolution-'));
  const module = new CtxCaptureModule();
  const fw = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'),
    membrane: { complete: async (_req: NormalizedRequest): Promise<NormalizedResponse> => { throw new Error('not used'); } } as never,
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test', ...agent }],
    modules: [module, ...modules],
    syncIntervalMs: 0,
    ...extra,
  });
  return { fw, dir, module, internals: fw as unknown as Internals };
}

/** A stand-in server. With no `prefix` it takes the default, `mcpl--<id>`. */
interface Server { id: string; prefix?: string; lists: string[]; disabledTools?: string[]; classes?: Record<string, string[]> }

/**
 * A framework whose MCPL servers are stand-ins, configured in the order given
 * as a connect configures them (its prefix and config together), with the
 * tool listing refreshMcplTools builds from what each lists. A stand-in
 * answers a call with its own id, and records it in `reached` as
 * `<id>:<the tool name it was sent>`.
 */
async function standIns(servers: Server[], agent: Record<string, unknown> = {}, modules: Module[] = []) {
  const h = await framework({}, agent, modules);
  const reached: string[] = [];
  // An emitter, so the framework's own handlers can be wired to it; it closes
  // as a server that will reconnect does, staying registered.
  const connection = (s: Server) => Object.assign(new EventEmitter(), {
    id: s.id,
    isConnected: true,
    willReconnect: true,
    mcpToolsAdvertised: true,
    sendToolsList: async () => ({
      tools: s.lists.map((name) => ({
        name,
        description: `${name} on ${s.id}`,
        inputSchema: { type: 'object', properties: {} },
        ...(s.classes?.[name] ? { _meta: { 'mcpl/class': s.classes[name] } } : {}),
      })),
    }),
    sendToolsCall: async (tool: string) => {
      reached.push(`${s.id}:${tool}`);
      return { content: [{ type: 'text', text: `${s.id}:${tool}` }] };
    },
  });
  const before = h.internals.mcplServerRegistry;
  const connections = new Map(servers.map((s) => [s.id, connection(s)]));
  h.internals.mcplServerRegistry = {
    getAllServers: () => [...connections.values()],
    getServer: (id: string) => connections.get(id) ?? null,
  };
  h.internals.mcplServerConfigs = new Map();
  h.internals.mcplPrefixMap = new Map();
  for (const s of servers) {
    h.internals.mcplServerConfigs.set(s.id, {
      id: s.id,
      command: 'node',
      ...(s.prefix === undefined ? {} : { toolPrefix: s.prefix }),
      ...(s.disabledTools ? { disabledTools: s.disabledTools } : {}),
    });
    h.internals.mcplPrefixMap.set(s.prefix ?? `mcpl--${s.id}`, s.id);
  }
  await h.internals.refreshMcplTools();

  // The model's path answers into the agent's tool round, as a tool-result event.
  const answers = new Map<string, ToolResult>();
  const push = h.fw.pushEvent.bind(h.fw);
  h.fw.pushEvent = (event) => {
    const e = event as { type: string; callId?: string; result?: ToolResult };
    if (e.type === 'tool-result' && e.callId && e.result) answers.set(e.callId, e.result);
    push(event);
  };

  /**
   * Call `name` by one path: the stand-in it reached, as `<id>:<tool>`, or how
   * it was answered without one: `refused` when the dispatcher refused it
   * before it opened (ToolResult.refused), as the model's path does and a
   * script's call too, and `failed` for any other failure, a programmatic
   * path's answer for the same reason included.
   */
  const call = async (path: Path, name: string): Promise<string> => {
    const count = reached.length;
    const c: ToolCall = { id: `call-${path}-${name}`, name, input: {} };
    if (path === 'model') {
      // The model's path sends synchronously, so a stand-in it reaches has
      // recorded it by now; otherwise its answer says what took the call.
      h.internals.dispatchToolCall('assistant', c);
      if (reached.length > count) return reached.at(-1)!;
      await waitFor(() => answers.has(c.id), `the model's answer to ${name}`);
      const answer = answers.get(c.id)!;
      return answer.success ? `answered: ${String(answer.data)}` : `${answer.refused ? 'refused' : 'failed'}: ${answer.error}`;
    }
    const result = path === 'executeToolCall'
      ? await h.fw.executeToolCall({ ...c, callerAgentName: 'assistant' })
      : await h.module.ctx!.callTool(c);
    if (reached.length > count) return reached.at(-1)!;
    return result.success ? `answered: ${String(result.data)}` : `${result.refused ? 'refused' : 'failed'}: ${result.error}`;
  };

  return {
    ...h,
    reached,
    call,
    server: (id: string) => connections.get(id)!,
    cleanup: async () => {
      h.internals.mcplServerRegistry = before;
      await h.fw.stop();
      rmSync(h.dir, { recursive: true, force: true });
    },
  };
}

const ORDERS = ['shorter prefix first', 'shorter prefix last'] as const;
const inOrder = <T>(order: typeof ORDERS[number], servers: T[]): T[] => order === 'shorter prefix first' ? servers : [...servers].reverse();


test("a call of a tool its server's policy denies is sent on no path: the model's is refused, the others fail", async () => {
  // Left out of the listing, `foo--secret` resolves to the longest prefix, `foo`'s, whose policy refuses it.
  const h = await standIns([{ id: 'short', prefix: 'foo', lists: ['secret', 'echo'], disabledTools: ['secret'] }]);
  try {
    for (const path of PATHS) {
      assert.equal(await h.call(path, 'foo--secret'), `${path === 'model' ? 'refused' : 'failed'}: foo--secret isn't allowed by this host's policy for the "short" server, ` +
        "so the call didn't run, and calling it again won't change that. If you need it, ask whoever runs this host.", `by ${path}`);
    }
    assert.equal(await h.call('executeToolCall', 'foo--echo'), 'short:echo', 'an allowed tool is sent');
  } finally {
    await h.cleanup();
  }
});

test('a name an MCPL prefix fits goes to MCPL on every path, even with no config for its server', async () => {
  const h = await standIns([{ id: 'short', prefix: 'foo', lists: ['echo'] }]);
  try {
    // A prefix with neither a config nor a server: answered as MCPL, never handed to a module.
    h.internals.mcplPrefixMap.set('ghost', 'ghost');
    // Every path's text says the same: the server isn't connected, and won't be
    // on its own. The model's call is refused; the others, which open no
    // RFC-007 call, fail.
    for (const path of ['executeToolCall', 'ctx.callTool', 'model'] as const) {
      assert.equal(await h.call(path, 'ghost--echo'), `${path === 'model' ? 'refused' : 'failed'}: The "ghost" server that provides ghost--echo isn't connected, ` +
        "and this host won't reconnect to it on its own, so the call didn't run. If you need it, ask whoever runs this host.", `by ${path}`);
    }
    // A server with no config is still sent the call.
    h.internals.mcplServerConfigs.delete('short');
    for (const path of PATHS) assert.equal(await h.call(path, 'foo--echo'), 'short:echo', `by ${path}`);
  } finally {
    await h.cleanup();
  }
});

test('a name no MCPL prefix fits falls through to the module registry on the programmatic paths', async () => {
  const h = await standIns([
    { id: 'short', prefix: 'foo', lists: ['echo'] },
    { id: 'nested', prefix: 'foo--bar', lists: ['echo'] },
  ]);
  try {
    for (const path of ['executeToolCall', 'ctx.callTool'] as const) {
      assert.equal(await h.call(path, 'ctx-capture--ping'), 'answered: module:ping', `a module's tool, by ${path}`);
      // `foo` is the start of `foobar`, but a prefix takes the separator too.
      assert.equal(await h.call(path, 'foobar--echo'), 'failed: Module not found: foobar, so nothing was done', `foobar--echo, by ${path}`);
    }
    assert.deepEqual(h.reached, [], 'no server was reached');
  } finally {
    await h.cleanup();
  }
});

test("a server's close forgets the class declarations of its own tools, and not another server's", async () => {
  const h = await standIns([
    { id: 'short', prefix: 'foo', lists: ['echo'], classes: { echo: ['comms'] } },
    { id: 'other', prefix: 'foo-bar', lists: ['echo'], classes: { echo: ['comms'] } },
  ]);
  const classOf = (tool: string) => h.fw.listToolClasses().find((t) => t.tool === tool);
  const short = h.server('short');
  h.internals.wireMcplEvents(short, h.internals.mcplServerConfigs.get('short'));
  try {
    assert.deepEqual(classOf('foo--echo'), { tool: 'foo--echo', class: ['comms'], source: 'server', serverId: 'short' }, 'as its listing declared');
    short.emit('close', null, null);
    assert.deepEqual(classOf('foo--echo'), { tool: 'foo--echo', class: [], source: 'none', serverId: 'short' }, 'unclassed once its server closed, until the next listing');
    assert.deepEqual(classOf('foo-bar--echo'), { tool: 'foo-bar--echo', class: ['comms'], source: 'server', serverId: 'other' }, "another server's stays, though its prefix begins with the closed one's");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Real fixture servers, configured at create(): the connect, the default
// prefix and the listing are the framework's own.
// ---------------------------------------------------------------------------

/** A fixture server answering `<id>:<tool>`. With no `prefix` it takes the default, `mcpl--<id>`. */
const fixture = (id: string, tools: string[], prefix?: string) => ({
  id,
  ...(prefix === undefined ? {} : { toolPrefix: prefix }),
  command: process.execPath,
  args: [FIXTURE],
  env: { NAME: id, TOOLS: tools.join(',') },
});

async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  // performance.now(), so a step in the wall clock can't end a wait early.
  const deadline = performance.now() + timeoutMs;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A framework with fixture servers, and a call by each path answered as the fixture answers it, `<server>:<tool>`. */
async function live(servers: ReturnType<typeof fixture>[], names: string[]) {
  const h = await framework({ mcplServers: servers });
  const cleanup = async () => {
    await h.fw.stop();
    rmSync(h.dir, { recursive: true, force: true });
  };
  try {
    await waitFor(() => names.every((n) => h.fw.getAllTools().some((t) => t.name === n)), 'the listing');
  } catch (err) {
    // Setup failed before the caller's try: stop the fixtures and remove the store here.
    await cleanup();
    throw err;
  }
  // The model's path answers into the agent's tool round, as a tool-result event.
  const answers = new Map<string, ToolResult>();
  const push = h.fw.pushEvent.bind(h.fw);
  h.fw.pushEvent = (event) => {
    const e = event as { type: string; callId?: string; result?: ToolResult };
    if (e.type === 'tool-result' && e.callId && e.result) answers.set(e.callId, e.result);
    push(event);
  };
  const answered = (result: ToolResult): string => {
    if (!result.success) return `refused: ${result.error}`;
    // The model's path joins a text result into a string; the programmatic paths keep its blocks.
    if (typeof result.data === 'string') return result.data;
    return (result.data as Array<{ text?: string }>).map((b) => b.text ?? '').join('');
  };
  let calls = 0;
  const call = async (path: Path, name: string): Promise<string> => {
    const c: ToolCall = { id: `live-${++calls}-${path}-${name}`, name, input: {} };
    if (path === 'model') {
      h.internals.dispatchToolCall('assistant', c);
      await waitFor(() => answers.has(c.id), `the model's answer to ${name}`);
      return answered(answers.get(c.id)!);
    }
    return answered(path === 'executeToolCall'
      ? await h.fw.executeToolCall({ ...c, callerAgentName: 'assistant' })
      : await h.module.ctx!.callTool(c));
  };
  return { ...h, call, cleanup };
}

test('with fixture servers configured at create(), one on the default prefix, every path reaches the server the model\'s call reaches', async () => {
  // `plain` takes the default prefix, `mcpl--plain`, and lists a name with
  // `--` in it; `inner`'s prefix doesn't meet it (#265).
  const servers = [
    fixture('plain', ['echo', 'inner--qux']),
    fixture('inner', ['echo'], 'inner'),
  ];
  const calls: Array<[string, string]> = [
    ['inner--echo', 'inner:echo'],
    ['mcpl--plain--echo', 'plain:echo'],
    ['mcpl--plain--inner--qux', 'plain:inner--qux'],
  ];
  for (const order of ORDERS) {
    const h = await live(inOrder(order, servers), calls.map(([n]) => n));
    try {
      for (const [name, expected] of calls) {
        for (const path of PATHS) assert.equal(await h.call(path, name), expected, `${order}: ${name} by ${path}`);
      }
    } finally {
      await h.cleanup();
    }
  }
});

test('after a refused connect of an already-registered id under a new prefix, every path still sends the tool name the model\'s call sends', async () => {
  const h = await live([fixture('solo', ['echo'], 'old')], ['old--echo']);
  try {
    await assert.rejects(h.fw.connectMcplServer(fixture('solo', ['echo'], 'renamed--longer')), /already registered/);
    for (const path of PATHS) assert.equal(await h.call(path, 'old--echo'), 'solo:echo', `by ${path}`);
  } finally {
    await h.cleanup();
  }
});

/**
 * Every place that decides which MCPL server a namespaced tool name belongs
 * to decides as the model's own call does, through resolveMcplTool: the
 * server whose tool listing offers the name, else the longest matching
 * prefix. One prefix can begin with another's: `foo` beside `foo--bar`, or
 * beside `foo-`, whose tools' names begin `foo---` (#227, #230). That holds
 * for a programmatic call, through the public executeToolCall or a module's
 * ctx.callTool, which also sends the server the tool name the model's call
 * sends; for an MCPL tool's source in the tool presentation; and for the
 * RFC-008 class declarations a server's close forgets. Where two servers list
 * the same full name, the listing holds the one listed last (#265).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import type { Module, ModuleContext, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, WorkspaceModule } from '../src/index.js';

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
  mcplToolClasses: Map<string, unknown[]>;
  refreshMcplTools(): Promise<void>;
  dispatchToolCall(agentName: string, call: ToolCall): void;
  dropMcplToolClasses(serverId: string): void;
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
interface Server { id: string; prefix?: string; lists: string[]; disabledTools?: string[] }

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
  const connection = (s: Server) => ({
    id: s.id,
    isConnected: true,
    mcpToolsAdvertised: true,
    sendToolsList: async () => ({ tools: s.lists.map((name) => ({ name, description: `${name} on ${s.id}`, inputSchema: { type: 'object', properties: {} } })) }),
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

  /** Call `name` by one path: the stand-in it reached, as `<id>:<tool>`, or how it was answered without one. */
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
      return answer.success ? `answered: ${String(answer.data)}` : `refused: ${answer.error}`;
    }
    const result = path === 'executeToolCall'
      ? await h.fw.executeToolCall({ ...c, callerAgentName: 'assistant' })
      : await h.module.ctx!.callTool(c);
    if (reached.length > count) return reached.at(-1)!;
    return result.success ? `answered: ${String(result.data)}` : `refused: ${result.error}`;
  };

  return {
    ...h,
    reached,
    call,
    cleanup: async () => {
      h.internals.mcplServerRegistry = before;
      await h.fw.stop();
      rmSync(h.dir, { recursive: true, force: true });
    },
  };
}

const ORDERS = ['shorter prefix first', 'shorter prefix last'] as const;
const inOrder = <T>(order: typeof ORDERS[number], servers: T[]): T[] => order === 'shorter prefix first' ? servers : [...servers].reverse();

const pairs: Array<{ name: string; servers: Server[]; calls: Array<[string, string]> }> = [
  {
    name: '`foo` beside `foo--bar`',
    servers: [
      { id: 'short', prefix: 'foo', lists: ['echo', 'bar--qux'] },
      { id: 'nested', prefix: 'foo--bar', lists: ['echo'] },
    ],
    calls: [
      ['foo--bar--echo', 'nested:echo'],
      ['foo--echo', 'short:echo'],
      // `foo` itself lists a tool named `bar--qux`: its listing decides.
      ['foo--bar--qux', 'short:bar--qux'],
      // A name no server listed goes to the longest matching prefix.
      ['foo--bar--unlisted', 'nested:unlisted'],
    ],
  },
  {
    name: '`foo` beside `foo-`',
    servers: [
      { id: 'short', prefix: 'foo', lists: ['echo'] },
      { id: 'dash', prefix: 'foo-', lists: ['echo'] },
    ],
    calls: [
      ['foo---echo', 'dash:echo'],
      ['foo--echo', 'short:echo'],
      ['foo---unlisted', 'dash:unlisted'],
    ],
  },
];

for (const pair of pairs) {
  for (const order of ORDERS) {
    test(`${pair.name}, ${order}: every path reaches the server the model's call reaches, with the same tool name`, async () => {
      const h = await standIns(inOrder(order, pair.servers));
      try {
        for (const [name, expected] of pair.calls) {
          for (const path of PATHS) assert.equal(await h.call(path, name), expected, `${name} by ${path}`);
        }
      } finally {
        await h.cleanup();
      }
    });
  }
}

test("a tool its own server's policy denies isn't in that server's listing, so every path reaches the other server's", async () => {
  for (const order of ORDERS) {
    const h = await standIns(inOrder(order, [
      { id: 'short', prefix: 'foo', lists: ['bar--echo'], disabledTools: ['bar--echo'] },
      { id: 'nested', prefix: 'foo--bar', lists: ['echo'] },
    ]));
    try {
      for (const path of PATHS) assert.equal(await h.call(path, 'foo--bar--echo'), 'nested:echo', `${order}, by ${path}`);
    } finally {
      await h.cleanup();
    }
  }
});

test("a call of a tool its server's policy denies is refused on every path, not sent", async () => {
  // Left out of the listing, `foo--secret` resolves to the longest prefix, `foo`'s, whose policy refuses it.
  const h = await standIns([{ id: 'short', prefix: 'foo', lists: ['secret', 'echo'], disabledTools: ['secret'] }]);
  try {
    for (const path of PATHS) {
      assert.equal(await h.call(path, 'foo--secret'), "refused: Tool 'foo--secret' is not permitted by this server's tool policy.", `by ${path}`);
    }
    assert.equal(await h.call('executeToolCall', 'foo--echo'), 'short:echo', 'an allowed tool is sent');
  } finally {
    await h.cleanup();
  }
});

test('a programmatic call sends the tool name the model\'s call sends, though the server\'s config has since taken another prefix', async () => {
  // What a connect of an already-registered id under a new toolPrefix leaves
  // behind when the registry refuses it: the old prefix still maps to the
  // server, and its config holds the new one.
  const h = await standIns([{ id: 'solo', prefix: 'old', lists: ['echo'] }]);
  try {
    h.internals.mcplPrefixMap.set('renamed--longer', 'solo');
    h.internals.mcplServerConfigs.set('solo', { id: 'solo', command: 'node', toolPrefix: 'renamed--longer' });
    for (const path of PATHS) assert.equal(await h.call(path, 'old--echo'), 'solo:echo', `by ${path}`);
  } finally {
    await h.cleanup();
  }
});

test('a name an MCPL prefix fits goes to MCPL on every path, even with no config for its server', async () => {
  const h = await standIns([{ id: 'short', prefix: 'foo', lists: ['echo'] }]);
  try {
    // A prefix with neither a config nor a server: refused as MCPL, never handed to a module.
    h.internals.mcplPrefixMap.set('ghost', 'ghost');
    for (const path of ['executeToolCall', 'ctx.callTool'] as const) {
      assert.equal(await h.call(path, 'ghost--echo'), 'refused: MCPL server ghost not found', `by ${path}`);
    }
    assert.equal(await h.call('model', 'ghost--echo'), 'refused: MCPL server not found: ghost', 'by model');
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
      assert.equal(await h.call(path, 'foobar--echo'), 'refused: Module not found: foobar', `foobar--echo, by ${path}`);
    }
    assert.deepEqual(h.reached, [], 'no server was reached');
  } finally {
    await h.cleanup();
  }
});

test("an MCPL tool's source in the tool presentation, and the description profile it takes, is the server a call of it reaches", async () => {
  for (const order of ORDERS) {
    const dir = mkdtempSync(join(tmpdir(), 'af-mcpl-presentation-'));
    // A presentation needs a workspace for its catalogue.
    const workspace = new WorkspaceModule({ mounts: [{ name: 'board', path: dir, mode: 'read-write', watch: 'never' }] });
    // A component description profile for each server, both naming `foo--bar--echo`.
    const profile = (id: string, tools: Record<string, string>) => {
      const path = join(dir, `${id}.json`);
      writeFileSync(path, JSON.stringify({ version: 1, tools: Object.fromEntries(Object.entries(tools).map(([n, d]) => [n, { description: d }])) }));
      return { source: `MCPL server: ${id}`, path };
    };
    const defaults = [
      profile('short', { 'foo--bar--echo': 'short says', 'foo--echo': 'short echo' }),
      profile('nested', { 'foo--bar--echo': 'nested says' }),
    ];
    const h = await standIns(inOrder(order, pairs[0]!.servers), {
      toolPresentation: { path: join(dir, 'tools.json'), cataloguePath: 'board/tools.md', defaults },
    }, [workspace]);
    try {
      const snapshot = h.fw.inspectToolPresentation('assistant')!;
      const entry = (name: string) => snapshot.entries.find((e) => e.name === name);
      // A profile bound to `MCPL server: short` describes only `short`'s tools.
      assert.equal(entry('foo--bar--echo')?.description, 'nested says', order);
      assert.equal(entry('foo--echo')?.description, 'short echo', order);
      assert.equal(entry('foo--bar--echo')?.source, 'MCPL server: nested', order);
      assert.equal(entry('foo--echo')?.source, 'MCPL server: short', order);
      assert.equal(entry('foo--bar--qux')?.source, 'MCPL server: short', order);
    } finally {
      await h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a server's close forgets the class declarations of its own tools, and not a nested prefix's", async () => {
  for (const order of ORDERS) {
    const h = await standIns(inOrder(order, pairs[0]!.servers));
    try {
      h.internals.mcplToolClasses = new Map([
        ['foo--echo', ['read']],
        ['foo--bar--qux', ['read']],
        ['foo--bar--echo', ['read']],
      ]);
      h.internals.dropMcplToolClasses('short');
      assert.deepEqual([...h.internals.mcplToolClasses.keys()], ['foo--bar--echo'], order);
    } finally {
      await h.cleanup();
    }
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
  // `plain` takes the default prefix, `mcpl--plain`; `inner`'s begins with it.
  const servers = [
    fixture('plain', ['echo', 'inner--qux']),
    fixture('inner', ['echo'], 'mcpl--plain--inner'),
  ];
  const calls: Array<[string, string]> = [
    ['mcpl--plain--inner--echo', 'inner:echo'],
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

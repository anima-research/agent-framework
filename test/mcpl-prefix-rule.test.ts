/**
 * Two MCPL servers can't give one tool name (#265). Their toolPrefixes may not
 * meet, which create(), a runtime connect and a restart refuse, naming both
 * servers and the rule. The prefix map those refusals read holds each
 * configured server's own claim: a connect refuses an id already registered
 * before it writes anything and drops any other entry of its id, and a
 * disconnect removes only its own server's prefix. A server that lists one name
 * more than once has its first listing offered to the model, and each refresh
 * that finds it raises an `mcpl-tool-duplicate` ops alert. The rule itself is
 * mcpl-prefixes-meet.test.ts's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import type { ToolCall, ToolResult, TraceEvent } from '../src/index.js';
import { AgentFramework } from '../src/index.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tool-listing-mcpl-server.mjs');

/** A framework, with the MCPL servers given configured at create(). */
async function create(mcplServers: Array<Record<string, unknown>> = []) {
  const dir = mkdtempSync(join(tmpdir(), 'af-mcpl-prefix-rule-'));
  try {
    const fw = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: { complete: async (_req: NormalizedRequest): Promise<NormalizedResponse> => { throw new Error('not used'); } } as never,
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
      modules: [],
      syncIntervalMs: 0,
      ...(mcplServers.length > 0 ? { mcplServers } : {}),
    } as never);
    const cleanup = async () => {
      await fw.stop();
      rmSync(dir, { recursive: true, force: true });
    };
    return { fw, cleanup };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** A fixture server answering `<id>:<tool>`, listing `echo`. */
const fixture = (id: string, toolPrefix?: string) => ({
  id,
  ...(toolPrefix === undefined ? {} : { toolPrefix }),
  command: process.execPath,
  args: [FIXTURE],
  env: { NAME: id, TOOLS: 'echo' },
});

/** A config whose command fails if it's ever run: a refusal must come first. */
const unrun = (id: string, toolPrefix?: string) => ({
  id,
  ...(toolPrefix === undefined ? {} : { toolPrefix }),
  command: process.execPath,
  args: ['-e', 'process.exit(3)'],
});

async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const offered = (fw: AgentFramework) => fw.getAllTools().map((t) => t.name).filter((name) => name.endsWith('--echo') || name.endsWith('--ping')).sort();

test('create() refuses two servers whose prefixes meet, naming both servers, both prefixes and the rule', async () => {
  const cases: Array<[ReturnType<typeof unrun>[], string[]]> = [
    [[unrun('short', 'foo'), unrun('nested', 'foo--bar')], ['"nested"', '"foo--bar"', '"short"', '"foo"']],
    [[unrun('nested', 'foo--bar'), unrun('short', 'foo')], ['"short"', '"foo"', '"nested"', '"foo--bar"']],
    [[unrun('short', 'foo'), unrun('dash', 'foo-')], ['"dash"', '"foo-"', '"short"', '"foo"']],
    // Default prefixes meet too: `mcpl--plain` and `mcpl--plain--inner`.
    [[unrun('plain'), unrun('plain--inner')], ['"plain--inner"', '"mcpl--plain--inner"', '"plain"', '"mcpl--plain"']],
  ];
  for (const [servers, parts] of cases) {
    await assert.rejects(create(servers), (err: Error) => {
      for (const part of [...parts, 'followed by "-"', 'followed by "--"', "a toolPrefix that doesn't meet the other's."]) {
        assert.ok(err.message.includes(part), `the refusal says ${part}: ${err.message}`);
      }
      return true;
    });
  }
});

test("create() takes prefixes that don't meet, and their servers' tools reach the model under each", async () => {
  const h = await create([fixture('short', 'foo'), fixture('dashed', 'foo-bar'), fixture('joined', 'foobar')]);
  try {
    await waitFor(() => offered(h.fw).length === 3, 'the listings');
    assert.deepEqual(offered(h.fw), ['foo--echo', 'foo-bar--echo', 'foobar--echo']);
  } finally {
    await h.cleanup();
  }
});

test('a runtime connect whose prefix meets a server\'s is refused before anything is registered under it', async () => {
  const h = await create([fixture('short', 'foo')]);
  try {
    await waitFor(() => offered(h.fw).length === 1, 'the listing');
    await assert.rejects(h.fw.connectMcplServer(unrun('nested', 'foo--bar')), /server "nested" toolPrefix "foo--bar" meets server "short"'s toolPrefix "foo"/);
    assert.deepEqual(h.fw.listMcplServers().map((s) => s.id), ['short'], 'nothing is registered under the refused id');
    const internals = h.fw as unknown as { mcplPrefixMap: Map<string, string> };
    assert.equal(internals.mcplPrefixMap.has('foo--bar'), false, 'nor its prefix');
    assert.deepEqual(offered(h.fw), ['foo--echo']);
  } finally {
    await h.cleanup();
  }
});

test('a restart under a prefix that meets another server\'s is refused, and the running server stays up', async () => {
  const h = await create([fixture('short', 'foo'), fixture('other', 'bar')]);
  try {
    await waitFor(() => offered(h.fw).length === 2, 'the listings');
    await assert.rejects(h.fw.restartMcplServer('other', fixture('other', 'foo-')), /server "other" toolPrefix "foo-" meets server "short"'s toolPrefix "foo"/);
    assert.equal(h.fw.listMcplServers().find((s) => s.id === 'other')?.connected, true, 'the server the restart was for is still connected');
    assert.deepEqual(offered(h.fw), ['bar--echo', 'foo--echo']);
  } finally {
    await h.cleanup();
  }
});

test('a runtime connect of an id already registered is refused before it writes anything', async () => {
  const h = await create([fixture('short', 'foo')]);
  try {
    await waitFor(() => offered(h.fw).length === 1, 'the listing');
    await assert.rejects(h.fw.connectMcplServer(unrun('short', 'elsewhere')), /MCPL server "short" is already registered/);
    assert.equal(h.fw.listMcplServers().find((s) => s.id === 'short')?.toolPrefix, 'foo', "the live server's config is kept");
    const internals = h.fw as unknown as { mcplPrefixMap: Map<string, string> };
    assert.deepEqual([...internals.mcplPrefixMap], [['foo', 'short']], 'and no prefix is claimed for the refused connect');
    assert.equal(h.fw.listMcplServers().find((s) => s.id === 'short')?.connected, true);
  } finally {
    await h.cleanup();
  }
});

test('a restart into the id of another live server is refused before it disconnects anything', async () => {
  const h = await create([fixture('first', 'one'), fixture('second', 'two')]);
  try {
    await waitFor(() => offered(h.fw).length === 2, 'the listings');
    await assert.rejects(h.fw.restartMcplServer('first', fixture('second', 'three')), /MCPL server "second" is already registered/);
    assert.equal(h.fw.listMcplServers().find((s) => s.id === 'first')?.connected, true, 'the server the restart was for is still connected');
    assert.equal(h.fw.listMcplServers().find((s) => s.id === 'second')?.toolPrefix, 'two', "and the other server's config is kept");
    assert.deepEqual(offered(h.fw), ['one--echo', 'two--echo']);
  } finally {
    await h.cleanup();
  }
});

test('a runtime connect retrying a server whose startup connect failed takes back its own prefix', async () => {
  // The failed startup connect leaves `flaky`'s config and prefix configured.
  const h = await create([unrun('flaky', 'flaky')]);
  try {
    assert.deepEqual(h.fw.listMcplServers().map((s) => [s.id, s.connected]), [['flaky', false]]);
    await h.fw.connectMcplServer(fixture('flaky', 'flaky'));
    await waitFor(() => offered(h.fw).length === 1, 'the listing');
    assert.deepEqual(offered(h.fw), ['flaky--echo']);
  } finally {
    await h.cleanup();
  }
});

test("a connect under a new prefix drops the prefix its id's failed connect left", async () => {
  // The failed startup connect leaves `flaky` configured under `p`.
  const h = await create([unrun('flaky', 'p')]);
  try {
    await assert.rejects(h.fw.connectMcplServer(unrun('x', 'p-')), /server "x" toolPrefix "p-" meets server "flaky"'s toolPrefix "p"/);
    const internals = h.fw as unknown as { mcplPrefixMap: Map<string, string> };
    await h.fw.connectMcplServer(fixture('flaky', 'q'));
    await waitFor(() => offered(h.fw).length === 1, 'the listing');
    assert.deepEqual([...internals.mcplPrefixMap], [['q', 'flaky']], 'one entry for the id');
    await h.fw.disconnectMcplServer('flaky');
    assert.deepEqual([...internals.mcplPrefixMap], [], 'and none once it has gone');
    await h.fw.connectMcplServer(fixture('other', 'p-'));
    await waitFor(() => offered(h.fw).length === 1, 'the new listing');
    assert.deepEqual(offered(h.fw), ['p---echo'], '`p-` meets nothing left behind');
  } finally {
    await h.cleanup();
  }
});

test("a restart that changes the server's id isn't refused by the prefix it replaces", async () => {
  // `mcpl--plain--x` meets `mcpl--plain`, but the restart disconnects `plain` first.
  const h = await create([fixture('plain')]);
  try {
    await waitFor(() => offered(h.fw).length === 1, 'the listing');
    await h.fw.restartMcplServer('plain', fixture('plain--x'));
    assert.deepEqual(h.fw.listMcplServers().map((s) => [s.id, s.connected]), [['plain--x', true]]);
    await waitFor(() => offered(h.fw).length === 1, 'the new listing');
    assert.deepEqual(offered(h.fw), ['mcpl--plain--x--echo']);
  } finally {
    await h.cleanup();
  }
});

test("a disconnect of an id with no config leaves the prefix another server set as its own", async () => {
  // `mcpl--ghost` is the default prefix of the unconfigured id `ghost`.
  const h = await create([fixture('owner', 'mcpl--ghost')]);
  try {
    await waitFor(() => offered(h.fw).length === 1, 'the listing');
    await h.fw.disconnectMcplServer('ghost');
    await assert.rejects(h.fw.connectMcplServer(unrun('dash', 'mcpl--ghost-')), /server "dash" toolPrefix "mcpl--ghost-" meets server "owner"'s toolPrefix "mcpl--ghost"/);
    assert.deepEqual(offered(h.fw), ['mcpl--ghost--echo']);
  } finally {
    await h.cleanup();
  }
});

/**
 * A framework with one stand-in server, `dup` on prefix `dup`, whose listing
 * is `tools`: each [name, description, _meta?]. The stand-in records each
 * call it reaches as `<tool>`.
 */
async function standIn(tools: Array<[string, string, Record<string, unknown>?]>) {
  const h = await create();
  const reached: string[] = [];
  const connection = {
    id: 'dup',
    isConnected: true,
    mcpToolsAdvertised: true,
    sendToolsList: async () => ({
      tools: tools.map(([name, description, _meta]) => ({ name, description, inputSchema: { type: 'object', properties: {} }, ...(_meta ? { _meta } : {}) })),
    }),
    sendToolsCall: async (tool: string) => {
      reached.push(tool);
      return { content: [{ type: 'text', text: `dup:${tool}` }] };
    },
  };
  const internals = h.fw as unknown as {
    mcplServerRegistry: unknown;
    mcplServerConfigs: Map<string, unknown>;
    mcplPrefixMap: Map<string, string>;
    refreshMcplTools(): Promise<void>;
    dispatchToolCall(agentName: string, call: ToolCall): void;
  };
  const before = internals.mcplServerRegistry;
  internals.mcplServerRegistry = { getAllServers: () => [connection], getServer: (id: string) => (id === 'dup' ? connection : null) };
  internals.mcplServerConfigs = new Map([['dup', { id: 'dup', command: 'node', toolPrefix: 'dup' }]]);
  internals.mcplPrefixMap = new Map([['dup', 'dup']]);
  const alerts: Array<Extract<TraceEvent, { type: 'ops:alert' }>> = [];
  h.fw.onTrace((event) => {
    if (event.type === 'ops:alert' && event.kind === 'mcpl-tool-duplicate') alerts.push(event as Extract<TraceEvent, { type: 'ops:alert' }>);
  });
  const answers = new Map<string, ToolResult>();
  const push = h.fw.pushEvent.bind(h.fw);
  h.fw.pushEvent = (event) => {
    const e = event as { type: string; callId?: string; result?: ToolResult };
    if (e.type === 'tool-result' && e.callId && e.result) answers.set(e.callId, e.result);
    push(event);
  };
  /** The model's call of `name`: the tool name the stand-in was sent, or the refusal. */
  const callModel = async (name: string): Promise<string> => {
    const count = reached.length;
    internals.dispatchToolCall('assistant', { id: `model-${name}-${count}`, name, input: {} });
    if (reached.length > count) return reached.at(-1)!;
    await waitFor(() => answers.has(`model-${name}-${count}`), `the model's answer to ${name}`);
    return `refused: ${answers.get(`model-${name}-${count}`)!.error}`;
  };
  const cleanup = async () => {
    // The stand-in registry has no closeAll for stop(): put the real one back.
    internals.mcplServerRegistry = before;
    await h.cleanup();
  };
  return { ...h, cleanup, alerts, refresh: () => internals.refreshMcplTools(), callModel };
}

test('a server listing one name twice is offered its first listing once, and a call reaches it', async () => {
  const h = await standIn([['echo', 'the first echo'], ['ping', 'ping'], ['echo', 'the second echo']]);
  try {
    await h.refresh();
    const echoes = h.fw.getAllTools().filter((t) => t.name === 'dup--echo');
    assert.deepEqual(echoes.map((t) => t.description), ['the first echo'], 'offered once, as first listed');
    assert.deepEqual(offered(h.fw), ['dup--echo', 'dup--ping']);
    assert.equal(await h.callModel('dup--echo'), 'echo', "the model's call reaches the server");
  } finally {
    await h.cleanup();
  }
});

test("a repeated name keeps its first listing's class and feature set", async () => {
  const h = await standIn([
    ['echo', 'the first echo', { 'mcpl/class': ['comms'], featureSet: 'first' }],
    ['echo', 'the second echo', { 'mcpl/class': ['files'], featureSet: 'second' }],
  ]);
  try {
    await h.refresh();
    const internals = h.fw as unknown as { mcplToolClasses: Map<string, string[]>; mcplToolFeatureSets: Map<string, string> };
    assert.deepEqual(internals.mcplToolClasses.get('dup--echo'), ['comms']);
    assert.equal(internals.mcplToolFeatureSets.get('dup--echo'), 'first');
  } finally {
    await h.cleanup();
  }
});

test('each refresh that finds a repeated name raises one alert naming it, and a listing without one raises none', async () => {
  const h = await standIn([['echo', 'one'], ['echo', 'two'], ['echo', 'three']]);
  try {
    await h.refresh();
    assert.equal(h.alerts.length, 1, 'one alert for the refresh');
    const [alert] = h.alerts;
    assert.equal(alert!.agentName, 'dup', 'raised for the server');
    assert.equal(
      alert!.message,
      'MCPL server "dup" lists the tool echo more than once. The first listing of it is the one used (offered to the model, or called through toolsets--act for a dynamic tool), and the rest are left out. ' +
        'A server should list each tool once, so this is for its maintainer to change.',
    );
    assert.deepEqual(alert!.data?.tools, ['echo'], 'named once, though listed three times');
    await h.refresh();
    assert.equal(h.alerts.length, 2, 'and again at the next refresh that finds it');
  } finally {
    await h.cleanup();
  }
  const clean = await standIn([['echo', 'one'], ['ping', 'ping']]);
  try {
    await clean.refresh();
    assert.deepEqual(offered(clean.fw), ['dup--echo', 'dup--ping'], 'the listing was read');
    assert.equal(clean.alerts.length, 0);
  } finally {
    await clean.cleanup();
  }
});

test('two names repeated in one listing give one alert naming both', async () => {
  const h = await standIn([['echo', 'a'], ['ping', 'b'], ['echo', 'c'], ['ping', 'd']]);
  try {
    await h.refresh();
    assert.equal(h.alerts.length, 1);
    const [alert] = h.alerts;
    assert.ok(alert!.message.includes('lists the tools echo, ping more than once. The first listing of each is the one used'), alert!.message);
    assert.deepEqual(alert!.data?.tools, ['echo', 'ping']);
    assert.deepEqual(offered(h.fw), ['dup--echo', 'dup--ping']);
  } finally {
    await h.cleanup();
  }
});

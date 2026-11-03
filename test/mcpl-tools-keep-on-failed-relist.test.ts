/**
 * A server that fails tools/list during a re-list (every reconnect re-lists
 * ALL servers) keeps its known tools instead of vanishing from the list: a
 * vanishing tool changes the top of every request (full prompt-cache
 * rewrite, twice) and hides the tools unannounced.
 */
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/framework.js';
import { MockMembrane } from './helpers/mock-membrane.js';

type Internals = {
  mcplServerRegistry: unknown;
  mcplServerConfigs: Map<string, Record<string, unknown>>;
  mcplPrefixMap: Map<string, string>;
  mcplTools: Array<{ name: string }>;
  mcplToolServers: Map<string, string>;
  mcplToolFeatureSets: Map<string, string>;
  refreshMcplTools(): Promise<void>;
  noteMcplServerClosed(serverId: string): void;
  wireMcplEvents(connection: unknown, config: unknown): void;
};

type Listed = { name: string; featureSet?: string; classes?: string[] } | null;

/** A stand-in MCPL server with main's connection fields. Its `lists` answers
 *  tools/list, or throws when `fails` is set; `beforeAnswer` runs as its
 *  listing is awaited, so a test can change another server meanwhile. */
type Server = {
  id: string;
  lists: Listed[];
  fails: boolean;
  error?: string;
  isConnected: boolean;
  willReconnect: boolean;
  mcpToolsAdvertised: boolean;
  beforeAnswer?: () => void | Promise<void>;
};

async function harness(ids: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-keep-'));
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }], modules: [],
  });
  const internals = fw as unknown as Internals;
  const reached: string[] = [];
  const fresh = (id: string): Server => ({ id, lists: [], fails: false, isConnected: true, willReconnect: true, mcpToolsAdvertised: true });
  const servers = new Map<string, Server>(ids.map((id) => [id, fresh(id)]));
  const connection = (s: Server) => Object.defineProperties(Object.assign(new EventEmitter(), {
    id: s.id,
    sendToolsList: async () => {
      await s.beforeAnswer?.();
      if (s.fails) throw new Error(s.error ?? `connection to "${s.id}" is closed`);
      return {
        tools: s.lists.map((t) => t === null ? null : {
          name: t.name, description: t.name, inputSchema: { type: 'object' },
          ...(t.featureSet === undefined ? {} : { featureSet: t.featureSet }),
          ...(t.classes === undefined ? {} : { _meta: { 'mcpl/class': t.classes } }),
        }),
      };
    },
    sendToolsCall: async (tool: string) => {
      reached.push(`${s.id}:${tool}`);
      return { content: [{ type: 'text', text: `${s.id}:${tool}` }] };
    },
    stopReconnecting: () => {},
    close: async () => {},
  }), {
    isConnected: { get: () => s.isConnected },
    willReconnect: { get: () => s.willReconnect },
    mcpToolsAdvertised: { get: () => s.mcpToolsAdvertised },
  });
  const connections = new Map([...servers.values()].map((s) => [s.id, connection(s)]));
  const registry = internals.mcplServerRegistry;
  internals.mcplServerRegistry = {
    getAllServers: () => [...connections.values()],
    getServer: (id: string) => connections.get(id) ?? null,
    closeAll: async () => {},
  };
  internals.mcplServerConfigs = new Map(ids.map((id) => [id, { id, command: 'node' }]));
  internals.mcplPrefixMap = new Map(ids.map((id) => [`mcpl--${id}`, id]));
  return {
    fw,
    internals,
    reached,
    server: (id: string) => servers.get(id)!,
    connection: (id: string) => connections.get(id)!,
    /** Lost for good: no reconnect, and the registry drops it. */
    lose: (id: string) => {
      Object.assign(servers.get(id)!, { isConnected: false, willReconnect: false });
      connections.delete(id);
    },
    /** A new connection under the id, as a connect makes. */
    connectAgain: (id: string) => {
      const s = fresh(id);
      servers.set(id, s);
      connections.set(id, connection(s));
      return s;
    },
    names: () => internals.mcplTools.map((t) => t.name),
    cleanup: async () => {
      internals.mcplServerRegistry = registry;
      await fw.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const tools = (...names: string[]): Listed[] => names.map((name) => ({ name }));

test('a failed re-list keeps that server\'s known tools; others refresh normally', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const h = await harness(['a', 'b', 'never']);
  try {
    const secret = 'sk-relist-0123456789abcdef';
    h.internals.mcplServerConfigs.set('b', { id: 'b', command: 'node', env: { API_KEY: secret } });
    h.server('a').lists = tools('send');
    h.server('b').lists = tools('read', 'write');
    h.server('never').fails = true;
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--a--send', 'mcpl--b--read', 'mcpl--b--write']);

    Object.assign(h.server('b'), { fails: true, isConnected: false, willReconnect: true, error: `refused with ${secret}` });
    h.server('a').lists = tools('send', 'react');
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--a--send', 'mcpl--a--react', 'mcpl--b--read', 'mcpl--b--write'],
      'b keeps its tools, in their place, while it reconnects; a picks up its new one');
    const lines = logged.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('"b"'));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^\[mcpl\] server "b": tools\/list failed \(refused with .+\); keeping its 2 known tool\(s\)$/);
    assert.ok(!lines[0].includes(secret), lines[0]);

    Object.assign(h.server('b'), { fails: false, isConnected: true });
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--a--send', 'mcpl--a--react', 'mcpl--b--read', 'mcpl--b--write']);
  } finally {
    await h.cleanup();
  }
});

test('a listing that answers but breaks off keeps the known tools whole, with no name twice', async () => {
  const h = await harness(['b']);
  try {
    h.server('b').lists = tools('read', 'write');
    await h.internals.refreshMcplTools();
    h.server('b').lists = [{ name: 'read' }, null, { name: 'write' }];
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.internals.mcplTools.map((t) => t.name), ['mcpl--b--read', 'mcpl--b--write']);
  } finally {
    await h.cleanup();
  }
});

test('a kept tool keeps its feature set and its server, beside another server lost while a later one lists, and a call reaches it', async () => {
  const h = await harness(['b', 'c', 'd']);
  try {
    h.server('b').lists = [{ name: 'read', featureSet: 'files' }, { name: 'write' }];
    h.server('c').lists = tools('ping');
    h.server('d').lists = tools('pong');
    await h.internals.refreshMcplTools();

    h.server('b').fails = true;
    h.server('d').beforeAnswer = () => {
      h.internals.noteMcplServerClosed('c');
      Object.assign(h.server('c'), { isConnected: false, willReconnect: false });
    };
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--b--read', 'mcpl--b--write', 'mcpl--d--pong']);
    assert.equal(h.internals.mcplToolFeatureSets.get('mcpl--b--read'), 'files');
    assert.equal(h.internals.mcplToolServers.get('mcpl--b--read'), 'b');
    assert.equal(h.internals.mcplToolServers.get('mcpl--b--write'), 'b');
    assert.equal(h.internals.mcplToolServers.has('mcpl--c--ping'), false);

    const result = await h.fw.executeToolCall({ id: 'call-1', name: 'mcpl--b--read', input: {}, callerAgentName: 'assistant' });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(h.reached, ['b:read']);
  } finally {
    await h.cleanup();
  }
});

test('a server that answers, then closes while a later server lists, keeps what is published while it reconnects, and none of the closed session\'s listing', async () => {
  const h = await harness(['b', 'c']);
  try {
    h.server('b').lists = tools('read');
    h.server('c').lists = tools('ping');
    await h.internals.refreshMcplTools();

    h.server('b').lists = tools('read', 'write');
    h.server('c').beforeAnswer = () => {
      h.internals.noteMcplServerClosed('b');
      Object.assign(h.server('b'), { isConnected: false, willReconnect: true });
    };
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--b--read', 'mcpl--c--ping'], 'its published tools, in their place');
    assert.equal(h.internals.mcplToolServers.get('mcpl--b--read'), 'b');
    assert.equal((h.internals as unknown as { mcplListedServers: Set<string> }).mcplListedServers.has('b'), false, 'its listing doesn\'t count');

    Object.assign(h.server('b'), { isConnected: true });
    h.server('c').beforeAnswer = () => {
      h.internals.noteMcplServerClosed('b');
      Object.assign(h.server('b'), { isConnected: false, willReconnect: false });
    };
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--c--ping'], 'lost for good the same way, it keeps nothing');
  } finally {
    await h.cleanup();
  }
});

test('a server that no longer serves keeps nothing: lost for good, or lost while a later server is listed', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const h = await harness(['b', 'c']);
  try {
    h.server('b').lists = tools('read');
    h.server('c').lists = tools('ping');
    await h.internals.refreshMcplTools();

    // Halted for good: not connected, and no reconnect will come.
    Object.assign(h.server('b'), { fails: true, isConnected: false, willReconnect: false });
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--c--ping'], 'a halted server\'s tools leave');
    assert.equal(h.internals.mcplToolServers.has('mcpl--b--read'), false);
    assert.deepEqual(logged.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('"b"')),
      ['[mcpl] server "b": tools/list failed (connection to "b" is closed); none of its tools are offered'],
      'and the line says so');

    // Reconnecting when its list fails, then halted while c's list is awaited.
    Object.assign(h.server('b'), { fails: false, isConnected: true, willReconnect: true });
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--b--read', 'mcpl--c--ping']);
    Object.assign(h.server('b'), { fails: true, isConnected: false, willReconnect: true });
    h.server('c').beforeAnswer = () => { h.server('b').willReconnect = false; };
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--c--ping'], 'the list published after b was lost holds none of its tools');
  } finally {
    await h.cleanup();
  }
});

test('a live server whose handshake advertised no tools has listed nothing, so none of its old tools are kept', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const h = await harness(['b']);
  try {
    h.server('b').lists = tools('read');
    await h.internals.refreshMcplTools();
    Object.assign(h.server('b'), { fails: true, isConnected: true, mcpToolsAdvertised: false });
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), []);
    h.server('b').isConnected = false;
    await h.internals.refreshMcplTools();
    assert.deepEqual(logged.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('tools/list failed')), [],
      'a failed listing of a server that advertised no tools, connected or reconnecting, logs nothing');
  } finally {
    await h.cleanup();
  }
});

test('a re-list that fails keeps what is published when it publishes, so an older re-list\'s newer listing stands', async () => {
  const h = await harness(['b', 'c']);
  try {
    h.server('b').lists = tools('read');
    h.server('c').lists = tools('ping');
    await h.internals.refreshMcplTools();

    let releaseOlder!: () => void;
    const older = new Promise<void>((resolve) => { releaseOlder = resolve; });
    let releaseNewer!: () => void;
    const newer = new Promise<void>((resolve) => { releaseNewer = resolve; });
    let bCalls = 0;
    let cCalls = 0;
    h.server('b').beforeAnswer = async () => {
      bCalls += 1;
      if (bCalls === 1) {
        // The older re-list's listing of b answers b's newer tools once released.
        await older;
        Object.assign(h.server('b'), { fails: false, lists: tools('read', 'write') });
      } else {
        h.server('b').fails = true;
      }
    };
    h.server('c').beforeAnswer = async () => {
      cCalls += 1;
      if (cCalls === 1) await newer;
    };
    const ticks = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

    const first = h.internals.refreshMcplTools();
    await ticks();
    const second = h.internals.refreshMcplTools();
    await ticks();
    assert.equal(bCalls, 2, 'the newer re-list has failed b and waits on c');
    releaseOlder();
    await first;
    assert.deepEqual(h.names(), ['mcpl--b--read', 'mcpl--b--write', 'mcpl--c--ping'], 'the older re-list published b\'s newer listing');
    releaseNewer();
    await second;
    assert.deepEqual(h.names(), ['mcpl--b--read', 'mcpl--b--write', 'mcpl--c--ping'], 'the newer re-list kept what was published, not what it saw at b\'s failure');
  } finally {
    await h.cleanup();
  }
});

test('a first listing that breaks off offers nothing, and its line says so', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const h = await harness(['b']);
  try {
    h.server('b').lists = [{ name: 'read' }, null];
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), []);
    const lines = logged.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('"b"'));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^\[mcpl\] server "b": tools\/list failed \(.+\); none of its tools are offered$/);
  } finally {
    await h.cleanup();
  }
});

test('a failed re-list once stop() has begun logs nothing', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const h = await harness(['b']);
  try {
    h.server('b').lists = tools('read');
    await h.internals.refreshMcplTools();
    h.server('b').fails = true;
    let stopping: Promise<void> | undefined;
    h.server('b').beforeAnswer = () => { stopping = h.fw.stop(); };
    await h.internals.refreshMcplTools();
    assert.ok(stopping, 'the listing began stop()');
    await stopping;
    assert.deepEqual(logged.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('tools/list failed')), []);
  } finally {
    await h.cleanup();
  }
});

test('a kept tool is unclassed after its server\'s close, until the server lists again', async () => {
  const h = await harness(['b']);
  try {
    h.server('b').lists = [{ name: 'read', classes: ['comms'] }];
    await h.internals.refreshMcplTools();
    h.internals.wireMcplEvents(h.connection('b'), h.internals.mcplServerConfigs.get('b'));
    const classOf = () => h.fw.listToolClasses().find((tool) => tool.tool === 'mcpl--b--read');
    assert.deepEqual(classOf(), { tool: 'mcpl--b--read', class: ['comms'], source: 'server', serverId: 'b' });

    Object.assign(h.server('b'), { fails: true, isConnected: false, willReconnect: true });
    h.connection('b').emit('close', null, null);
    assert.deepEqual(classOf(), { tool: 'mcpl--b--read', class: [], source: 'none', serverId: 'b' }, 'the close forgot its class');
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--b--read'], 'kept while it reconnects');
    assert.deepEqual(classOf(), { tool: 'mcpl--b--read', class: [], source: 'none', serverId: 'b' }, 'its class went with the close');

    Object.assign(h.server('b'), { fails: false, isConnected: true });
    await h.internals.refreshMcplTools();
    assert.deepEqual(classOf(), { tool: 'mcpl--b--read', class: ['comms'], source: 'server', serverId: 'b' }, 'its next listing classes it again');
  } finally {
    await h.cleanup();
  }
});

test('a server whose handshake advertised no tools keeps nothing while it reconnects, and logs nothing', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const h = await harness(['b']);
  try {
    Object.assign(h.server('b'), { mcpToolsAdvertised: false, lists: tools('read') });
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--b--read'], 'it listed a tool though it advertised none');
    Object.assign(h.server('b'), { fails: true, isConnected: false, willReconnect: true });
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), [], 'none of its tools are kept');
    assert.deepEqual(logged.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('tools/list failed')), []);
  } finally {
    await h.cleanup();
  }
});

test('a kept tool of a server that hasn\'t closed keeps the class it declared', async () => {
  const h = await harness(['b']);
  try {
    h.server('b').lists = [{ name: 'read', classes: ['comms'] }];
    await h.internals.refreshMcplTools();
    h.server('b').fails = true;
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.fw.listToolClasses().find((tool) => tool.tool === 'mcpl--b--read'), { tool: 'mcpl--b--read', class: ['comms'], source: 'server', serverId: 'b' });
  } finally {
    await h.cleanup();
  }
});

test('kept tools of servers on either side of a listed one stay in their places', async () => {
  const h = await harness(['a', 'b', 'c']);
  try {
    h.server('a').lists = tools('read', 'write');
    h.server('b').lists = tools('ping');
    h.server('c').lists = tools('list', 'get');
    await h.internals.refreshMcplTools();
    const before = h.names();
    h.server('a').fails = true;
    h.server('c').fails = true;
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), before);
  } finally {
    await h.cleanup();
  }
});

test('a server whose handshake advertised no tools keeps nothing when it closes while a later server lists', async () => {
  const h = await harness(['b', 'c']);
  try {
    Object.assign(h.server('b'), { mcpToolsAdvertised: false, lists: tools('read') });
    h.server('c').lists = tools('ping');
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--b--read', 'mcpl--c--ping'], 'it listed a tool though it advertised none');
    h.server('c').beforeAnswer = () => {
      h.internals.noteMcplServerClosed('b');
      Object.assign(h.server('b'), { isConnected: false, willReconnect: true });
    };
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--c--ping']);
  } finally {
    await h.cleanup();
  }
});

test('a server that reconnects without advertising tools before the re-list publishes keeps none of the old session\'s tools', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = await harness(['b', 'c']);
  try {
    h.server('b').lists = tools('read');
    h.server('c').lists = tools('ping');
    await h.internals.refreshMcplTools();
    h.server('b').fails = true;
    h.server('c').beforeAnswer = () => {
      h.internals.noteMcplServerClosed('b');
      Object.assign(h.server('b'), { isConnected: true, mcpToolsAdvertised: false });
    };
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--c--ping']);
  } finally {
    await h.cleanup();
  }
});

test('a new connection under the id of a server lost for good keeps none of its tools while the refresh that removes them waits', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = await harness(['b', 'c']);
  try {
    h.server('b').lists = tools('read');
    h.server('c').lists = tools('ping');
    await h.internals.refreshMcplTools();

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let waiting!: () => void;
    const removalWaits = new Promise<void>((resolve) => { waiting = resolve; });
    let cCalls = 0;
    h.server('c').beforeAnswer = async () => {
      cCalls += 1;
      if (cCalls === 1) {
        waiting();
        await held;
      }
    };
    h.lose('b');
    const removal = h.internals.refreshMcplTools();
    await removalWaits;
    h.connectAgain('b').fails = true;
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--c--ping'], 'the new connection\'s failed first listing keeps none of the lost server\'s tools');
    release();
    await removal;
    assert.deepEqual(h.names(), ['mcpl--c--ping']);
  } finally {
    await h.cleanup();
  }
});

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
};

type Listed = { name: string; featureSet?: string } | null;

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
  beforeAnswer?: () => void;
};

async function harness(ids: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-keep-'));
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }], modules: [],
  });
  const internals = fw as unknown as Internals;
  const reached: string[] = [];
  const servers = new Map<string, Server>(ids.map((id) => [id, {
    id, lists: [], fails: false, isConnected: true, willReconnect: true, mcpToolsAdvertised: true,
  }]));
  const connection = (s: Server) => Object.defineProperties(Object.assign(new EventEmitter(), {
    id: s.id,
    sendToolsList: async () => {
      s.beforeAnswer?.();
      if (s.fails) throw new Error(s.error ?? `connection to "${s.id}" is closed`);
      return {
        tools: s.lists.map((t) => t === null ? null : {
          name: t.name, description: t.name, inputSchema: { type: 'object' },
          ...(t.featureSet === undefined ? {} : { featureSet: t.featureSet }),
        }),
      };
    },
    sendToolsCall: async (tool: string) => {
      reached.push(`${s.id}:${tool}`);
      return { content: [{ type: 'text', text: `${s.id}:${tool}` }] };
    },
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
  };
  internals.mcplServerConfigs = new Map(ids.map((id) => [id, { id, command: 'node' }]));
  internals.mcplPrefixMap = new Map(ids.map((id) => [`mcpl--${id}`, id]));
  return {
    fw,
    internals,
    reached,
    server: (id: string) => servers.get(id)!,
    names: () => internals.mcplTools.map((t) => t.name).sort(),
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
    assert.deepEqual(h.names(), ['mcpl--a--react', 'mcpl--a--send', 'mcpl--b--read', 'mcpl--b--write'],
      'b keeps its tools while it reconnects; a picks up its new one');
    const lines = logged.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('"b"'));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^\[mcpl\] server "b": tools\/list failed \(refused with .+\); keeping its 2 known tool\(s\)$/);
    assert.ok(!lines[0].includes(secret), lines[0]);

    Object.assign(h.server('b'), { fails: false, isConnected: true });
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--a--react', 'mcpl--a--send', 'mcpl--b--read', 'mcpl--b--write']);
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

test('a kept tool keeps its feature set and its server, so a later filter keeps it and a call reaches it', async () => {
  const h = await harness(['b', 'c']);
  try {
    h.server('b').lists = [{ name: 'read', featureSet: 'files' }, { name: 'write' }];
    h.server('c').lists = tools('ping');
    await h.internals.refreshMcplTools();

    // b's list fails while its connection stays up; c closes as its listing
    // is awaited, so its listing doesn't count and the published list is
    // filtered to the tools a server is known for.
    h.server('b').fails = true;
    h.server('c').beforeAnswer = () => h.internals.noteMcplServerClosed('c');
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--b--read', 'mcpl--b--write']);
    assert.equal(h.internals.mcplToolFeatureSets.get('mcpl--b--read'), 'files');
    assert.equal(h.internals.mcplToolServers.get('mcpl--b--read'), 'b');
    assert.equal(h.internals.mcplToolServers.get('mcpl--b--write'), 'b');

    const result = await h.fw.executeToolCall({ id: 'call-1', name: 'mcpl--b--read', input: {}, callerAgentName: 'assistant' });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(h.reached, ['b:read']);
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
    assert.deepEqual(logged.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('keeping')), [],
      'and nothing says they were kept');

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

test('a live server whose handshake advertised no tools has listed nothing, so none of its old tools are kept', async () => {
  const h = await harness(['b']);
  try {
    h.server('b').lists = tools('read');
    await h.internals.refreshMcplTools();
    Object.assign(h.server('b'), { fails: true, isConnected: true, mcpToolsAdvertised: false });
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), []);
  } finally {
    await h.cleanup();
  }
});

test('the tool policy and prefix in force decide which kept tools stay', async () => {
  const h = await harness(['b']);
  try {
    h.server('b').lists = tools('read', 'write');
    await h.internals.refreshMcplTools();
    h.internals.mcplServerConfigs.set('b', { id: 'b', command: 'node', disabledTools: ['write'] });
    h.server('b').fails = true;
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), ['mcpl--b--read'], 'a tool the policy now denies isn\'t kept');

    h.internals.mcplServerConfigs.set('b', { id: 'b', command: 'node', toolPrefix: 'files' });
    await h.internals.refreshMcplTools();
    assert.deepEqual(h.names(), [], 'a tool under a prefix no longer configured isn\'t kept');
  } finally {
    await h.cleanup();
  }
});

// The host's own toolsets (src/host-presentation.ts): the built-in "settings"
// toolset of rarely-used host tools, and each MCPL server's tab (full, a
// hidden tab, or a closed tab), switched by the agent with toolsets--open and
// toolsets--close and kept across restarts. The tool list changes only on a
// switch or a visibility change, never on open, act or close.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AutobiographicalStrategy } from '@animalabs/context-manager';
import { AgentFramework, WorkspaceModule } from '../src/index.js';
import type { Module, ModuleContext, ToolCall, ToolResult, ToolDefinition } from '../src/types/index.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { startScriptedServer, waitFor, windowText, resultText, type Json } from './helpers/toolset-servers.js';

const strategy = () => new AutobiographicalStrategy({
  adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30_000, kvStableReachTokens: 8_000,
});

/** A module with a first-class tool, two utilities, and a tool it places in the built-in toolset. */
class StubModule implements Module {
  readonly name = 'stub';
  calls: ToolCall[] = [];
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [
      { name: 'frontline', description: 'Always-on tool.', inputSchema: { type: 'object' } },
      { name: 'adminish', description: 'An administrative tool.', inputSchema: { type: 'object' } },
    ];
  }
  getUtilities(): ToolDefinition[] {
    return [
      {
        name: 'rare_op',
        description: 'A rarely-used operation. Second sentence.',
        inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['soft', 'hard'] } }, required: ['mode'] },
      },
      { name: 'other_op', description: 'Another one.', inputSchema: { type: 'object' } },
    ];
  }
  toolPlacement(name: string): 'header' | 'builtin' | undefined {
    return name === 'adminish' ? 'builtin' : undefined;
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return { success: true, data: { handled: call.name, input: call.input } };
  }
  async onProcess(): Promise<any> { return {}; }
}

async function makeFramework(opts: {
  dir?: string;
  modules?: Module[];
  servers?: McplServerConfig[];
  toolPresentation?: boolean;
  /** Overrides for the agent, or more agents beside it. */
  agent?: Record<string, unknown>;
  others?: string[];
} = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'host-toolsets-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', strategy: strategy(),
      ...(opts.toolPresentation ? { toolPresentation: { path: join(dir, 'tools.json'), cataloguePath: 'board/tools.md' } } : {}),
      ...opts.agent,
    }, ...(opts.others ?? []).map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.`, strategy: strategy() }))],
    modules: opts.modules ?? [new StubModule()],
    ...(opts.servers ? { mcplServers: opts.servers } : {}),
  });
  return {
    framework,
    dir,
    async stop(keep = false) {
      await framework.stop();
      if (!keep) rmSync(dir, { recursive: true, force: true });
    },
  };
}

const call = (framework: AgentFramework, name: string, input: Json = {}, agent = 'scout'): Promise<ToolResult> =>
  framework.executeToolCall({ id: `c-${Math.random().toString(36).slice(2, 10)}`, name, input, callerAgentName: agent } as never);

const header = async (framework: AgentFramework, agent = 'scout'): Promise<ToolDefinition[]> =>
  (await framework.previewActivation(agent)).tools ?? [];
const headerNames = async (framework: AgentFramework, agent = 'scout') => (await header(framework, agent)).map((t) => t.name);

describe('the built-in toolset', () => {
  it('holds the host\'s rarely-used tools and module utilities; the tool list keeps the rest and the meta-tools', async () => {
    const h = await makeFramework();
    try {
      const names = await headerNames(h.framework);
      for (const meta of ['toolsets--open', 'toolsets--act', 'toolsets--look', 'toolsets--close']) assert.ok(names.includes(meta), `${meta} in the tool list`);
      assert.ok(names.includes('stub--frontline'), 'a module\'s tool stays in the tool list by default');
      for (const out of ['agent_settings', 'stub--rare_op', 'stub--other_op', 'stub--adminish']) {
        assert.ok(!names.includes(out), `${out} is out of the tool list`);
      }
      const look = resultText(await call(h.framework, 'toolsets--look', { toolset: 'settings' }));
      for (const inside of ['agent_settings', 'stub--rare_op', 'stub--other_op', 'stub--adminish']) assert.match(look, new RegExp(`${inside}\\(`), `${inside} listed in settings`);
      assert.doesNotMatch(look, /stub--frontline\(/, 'a tool-list tool is not in it');
    } finally { await h.stop(); }
  });

  it('places the framework\'s own rarely-used tools there and leaves the everyday ones exposed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-toolsets-ws-'));
    const workspace = new WorkspaceModule({ mounts: [{ name: 'board', path: dir, mode: 'read-write', watch: 'never' }] });
    const h = await makeFramework({ dir, modules: [workspace] });
    try {
      const names = await headerNames(h.framework);
      const all = h.framework.getAllTools().map((t) => t.name);
      for (const folded of ['agent_settings', 'wake_add_rule', 'wake_remove_rule', 'gate_status', 'event_tags', 'workspace--status']) {
        if (all.includes(folded)) assert.ok(!names.includes(folded), `${folded} folded`);
      }
      assert.ok(all.includes('workspace--status') && all.includes('agent_settings'), 'the folded tools exist');
      for (const exposed of ['workspace--read', 'workspace--write', 'workspace--edit', 'workspace--grep', 'save_recent_image', 'read_image', 'fetch_reference']) {
        assert.ok(names.includes(exposed), `${exposed} stays in the tool list`);
      }
    } finally { await h.stop(); }
  });

  it('calls one of its tools through act only while it is open', async () => {
    const stub = new StubModule();
    const h = await makeFramework({ modules: [stub] });
    try {
      const before = await call(h.framework, 'toolsets--act', { tool: 'stub--rare_op', args: { mode: 'soft' } });
      assert.ok(before.isError, 'refused while closed');
      assert.match(String(before.error), /isn't open: toolsets--open \{toolset:"settings"\}/);
      assert.equal(stub.calls.length, 0, 'nothing ran');

      const opened = resultText(await call(h.framework, 'toolsets--open', { toolset: 'settings' }));
      assert.match(opened, /\[settings\] open/);
      assert.match(opened, /stub--rare_op\(mode: "soft"\|"hard"\)/);

      const acted = await call(h.framework, 'toolsets--act', { tool: 'stub--rare_op', args: { mode: 'soft' } });
      assert.ok(acted.success, acted.error);
      assert.equal(stub.calls[0]!.name, 'rare_op', 'the module sees its own tool, unprefixed');
      assert.deepEqual(stub.calls[0]!.input, { mode: 'soft' });

      assert.match(resultText(await call(h.framework, 'toolsets--close', { toolset: 'settings' })), /\[settings\] closed/);
      const after = await call(h.framework, 'toolsets--act', { tool: 'stub--adminish', args: {} });
      assert.ok(after.isError && /isn't open/.test(String(after.error)), 'refused again once closed');
      assert.equal(stub.calls.length, 1);
    } finally { await h.stop(); }
  });

  it('leaves the tool list byte for byte as it was through open, act and close', async () => {
    const h = await makeFramework();
    try {
      const before = JSON.stringify(await header(h.framework));
      await call(h.framework, 'toolsets--open', { toolset: 'settings' });
      assert.equal(JSON.stringify(await header(h.framework)), before, 'after open');
      await call(h.framework, 'toolsets--act', { tool: 'stub--rare_op', args: { mode: 'hard' } });
      assert.equal(JSON.stringify(await header(h.framework)), before, 'after act');
      await call(h.framework, 'toolsets--close', { toolset: 'settings' });
      assert.equal(JSON.stringify(await header(h.framework)), before, 'after close');
    } finally { await h.stop(); }
  });

  it('checks act\'s arguments against the tool\'s definition before calling it', async () => {
    const stub = new StubModule();
    const h = await makeFramework({ modules: [stub] });
    try {
      await call(h.framework, 'toolsets--open', { toolset: 'settings' });
      const wrong = await call(h.framework, 'toolsets--act', { tool: 'stub--rare_op', args: { mode: 'loud' } });
      assert.ok(wrong.isError);
      assert.match(String(wrong.error), /Invalid arguments for stub--rare_op: .*Nothing was sent/s);
      const missing = await call(h.framework, 'toolsets--act', { tool: 'stub--rare_op', args: {} });
      assert.ok(missing.isError && /Invalid arguments for stub--rare_op/.test(String(missing.error)));
      assert.equal(stub.calls.length, 0, 'nothing ran');
    } finally { await h.stop(); }
  });

  it('keeps utilities out of the tool list of an agent that may not use the meta-tools, whose other tools all stay', async () => {
    const h = await makeFramework({ agent: { allowedTools: ['stub--frontline', 'stub--adminish', 'stub--rare_op', 'agent_settings'] } });
    try {
      const names = await headerNames(h.framework);
      for (const kept of ['stub--frontline', 'stub--adminish', 'agent_settings']) assert.ok(names.includes(kept), `${kept} stays`);
      assert.ok(!names.includes('stub--rare_op'), 'a utility is never a tool-list tool');
      assert.ok(!names.some((n) => n.startsWith('toolsets--')));
    } finally { await h.stop(); }
  });

  it('moves an unreadable state file aside rather than writing over it', async () => {
    const { writeFileSync, readdirSync, readFileSync } = await import('node:fs');
    const first = await makeFramework();
    await call(first.framework, 'toolsets--open', { toolset: 'settings' });
    await first.stop(true);
    const dir = first.dir;
    writeFileSync(join(dir, 'store', 'config', 'toolsets.json'), 'not json at all');
    const h = await makeFramework({ dir });
    try {
      await call(h.framework, 'toolsets--open', { toolset: 'settings' });
      const files = readdirSync(join(dir, 'store', 'config'));
      const aside = files.find((f) => f.startsWith('toolsets.json.unreadable-'));
      assert.ok(aside, files.join(', '));
      assert.equal(readFileSync(join(dir, 'store', 'config', aside!), 'utf8'), 'not json at all', 'kept as it was');
      assert.equal(JSON.parse(readFileSync(join(dir, 'store', 'config', 'toolsets.json'), 'utf8')).version, 1);
    } finally { await h.stop(); }
  });

  it('stays open across a restart', async () => {
    const stub = new StubModule();
    const first = await makeFramework({ modules: [stub] });
    await call(first.framework, 'toolsets--open', { toolset: 'settings' });
    await first.stop(true);
    const stub2 = new StubModule();
    const second = await makeFramework({ dir: first.dir, modules: [stub2] });
    try {
      const acted = await call(second.framework, 'toolsets--act', { tool: 'stub--rare_op', args: { mode: 'soft' } });
      assert.ok(acted.success, acted.error);
      assert.equal(stub2.calls.length, 1);
    } finally { await second.stop(); }
  });
});

describe('reminders', () => {
  it('reminds of an open host toolset once its announcement has left the context', async () => {
    const h = await makeFramework();
    try {
      const opened = resultText(await call(h.framework, 'toolsets--open', { toolset: 'settings' }));
      const hub = (h.framework as unknown as { toolsetHub: { observeCompile(a: string, m: unknown[]): void; reminderFor(a: string): string | null } }).toolsetHub;
      const message = (text: string) => ({ participant: 'scout', content: [{ type: 'text', text }] });
      hub.observeCompile('scout', [message(opened)]);
      assert.equal(hub.reminderFor('scout'), null, 'nothing due while the announcement is in the context');
      hub.observeCompile('scout', [message('later talk')]);
      assert.match(hub.reminderFor('scout') ?? '', /\[settings\] open: .*agent_settings.*toolsets--close \{toolset:"settings"\}/s);
      await call(h.framework, 'toolsets--close', { toolset: 'settings' });
      hub.observeCompile('scout', [message('later talk')]);
      assert.equal(hub.reminderFor('scout'), null, 'nothing to remind of once it is closed');
    } finally { await h.stop(); }
  });
});

describe('reminders across a restart', () => {
  it('reminds of a toolset left open across a restart whose announcement the context no longer carries', async () => {
    const first = await makeFramework();
    await call(first.framework, 'toolsets--open', { toolset: 'settings' });
    await first.stop(true);
    const second = await makeFramework({ dir: first.dir });
    try {
      const hub = (second.framework as unknown as { toolsetHub: { observeCompile(a: string, m: unknown[]): void; reminderFor(a: string): string | null } }).toolsetHub;
      hub.observeCompile('scout', [{ participant: 'scout', content: [{ type: 'text', text: 'after the restart' }] }]);
      assert.match(hub.reminderFor('scout') ?? '', /\[settings\] open: .*agent_settings/s);
    } finally { await second.stop(); }
  });
});

describe('utils', () => {
  it('is gone: no such tool, and a call of it says where utilities went', async () => {
    const h = await makeFramework();
    try {
      assert.ok(!h.framework.getAllTools().some((t) => t.name === 'utils'), 'no utils tool');
      assert.ok(!(await headerNames(h.framework)).includes('utils'));
      const answer = await call(h.framework, 'utils', { action: 'list' });
      assert.ok(answer.isError);
      assert.match(String(answer.error), /utils was removed.*toolsets--look \{toolset:"settings"\}/s);
    } finally { await h.stop(); }
  });
});

describe('tool visibility', () => {
  it('moves a hidden host tool into the built-in toolset, and showing it moves it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-toolsets-vis-'));
    const stub = new StubModule();
    const workspace = new WorkspaceModule({ mounts: [{ name: 'board', path: dir, mode: 'read-write', watch: 'never' }] });
    const h = await makeFramework({ dir, modules: [stub, workspace], toolPresentation: true });
    try {
      assert.ok((await headerNames(h.framework)).includes('stub--frontline'));
      assert.ok(!(await headerNames(h.framework)).includes('set_tool_visibility'), 'the visibility tools are in the built-in toolset');
      await call(h.framework, 'toolsets--open', { toolset: 'settings' });
      const hid = await call(h.framework, 'toolsets--act', { tool: 'set_tool_visibility', args: { name: 'stub--frontline', visible: false } });
      assert.ok(hid.success, hid.error);
      assert.ok(!(await headerNames(h.framework)).includes('stub--frontline'), 'hidden: out of the tool list');
      assert.match(resultText(await call(h.framework, 'toolsets--look', { toolset: 'settings' })), /stub--frontline\(/, 'and in the built-in toolset');
      const acted = await call(h.framework, 'toolsets--act', { tool: 'stub--frontline', args: {} });
      assert.ok(acted.success, acted.error);
      assert.equal(stub.calls.at(-1)!.name, 'frontline');
      await call(h.framework, 'toolsets--act', { tool: 'set_tool_visibility', args: { name: 'stub--frontline', visible: true } });
      assert.ok((await headerNames(h.framework)).includes('stub--frontline'), 'shown: back in the tool list');
      assert.doesNotMatch(resultText(await call(h.framework, 'toolsets--look', { toolset: 'settings' })), /stub--frontline\(/);
    } finally { await h.stop(); }
  });

  it('refuses to hide the meta-tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-toolsets-vis2-'));
    const workspace = new WorkspaceModule({ mounts: [{ name: 'board', path: dir, mode: 'read-write', watch: 'never' }] });
    const h = await makeFramework({ dir, modules: [workspace], toolPresentation: true });
    try {
      await call(h.framework, 'toolsets--open', { toolset: 'settings' });
      const hid = await call(h.framework, 'toolsets--act', { tool: 'set_tool_visibility', args: { name: 'toolsets--open', visible: false } });
      assert.ok(!hid.success);
      assert.match(String(hid.error), /can't be hidden/);
    } finally { await h.stop(); }
  });
});

const PING = { name: 'ping', description: 'Ping the server.', inputSchema: { type: 'object' } };

/** A plain MCPL server (no RFC-014) that answers tools/call. */
async function pingServer() {
  const calls: Json[] = [];
  const server = await startScriptedServer({
    advert: { featureSets: { 'srv.tools': { description: 'tools', uses: ['tools'] }, 'srv.events': { description: 'events', uses: ['pushEvents'] } } },
    tools: [PING],
    on: (msg, peer) => {
      if (msg.method === 'tools/call') {
        calls.push(msg);
        peer.reply(msg.id, { content: [{ type: 'text', text: 'pong' }] });
      } else if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  return { server, calls };
}

const isOpenSocket = (ws: { readyState: number }) => ws.readyState === 1;

describe('server tabs', () => {
  it('switch full → hidden tab → open → closed tab → open (reconnected) → full', async () => {
    const { server, calls } = await pingServer();
    const h = await makeFramework({ servers: [{ id: 'srv', url: server.url, toolPrefix: 'srv' }] });
    try {
      await h.framework.start();
      await waitFor(() => h.framework.getAllTools().some((t) => t.name === 'srv--ping'), 'srv connected');
      assert.ok((await headerNames(h.framework)).includes('srv--ping'), 'full: in the tool list');

      assert.match(resultText(await call(h.framework, 'toolsets--close', { server: 'srv' })), /leave your tool list/);
      assert.ok(!(await headerNames(h.framework)).includes('srv--ping'), 'hidden tab: out of the tool list');
      assert.ok(isOpenSocket(server.peer.ws), 'still connected');
      const closedAct = await call(h.framework, 'toolsets--act', { tool: 'srv--ping', args: {} });
      assert.ok(closedAct.isError && /isn't open: toolsets--open \{server:"srv"\}/.test(String(closedAct.error)));

      const hidden = JSON.stringify(await header(h.framework));
      assert.match(resultText(await call(h.framework, 'toolsets--open', { server: 'srv' })), /\[tab srv\] open[\s\S]*srv--ping\(\)/);
      const acted = await call(h.framework, 'toolsets--act', { tool: 'srv--ping', args: {} });
      assert.ok(acted.success, acted.error);
      assert.equal(calls.length, 1, 'the server was called');
      const bare = await call(h.framework, 'toolsets--act', { server: 'srv', tool: 'ping', args: {} });
      assert.ok(bare.success, bare.error);
      await call(h.framework, 'toolsets--close', { server: 'srv' });
      assert.equal(JSON.stringify(await header(h.framework)), hidden, 'open, act and close left the tool list as it was');

      const firstSocket = server.peer.ws;
      assert.match(resultText(await call(h.framework, 'toolsets--close', { server: 'srv', disconnect: true })), /disconnected/);
      await waitFor(() => !isOpenSocket(firstSocket), 'the connection closed');
      const refused = await call(h.framework, 'toolsets--act', { server: 'srv', tool: 'ping', args: {} });
      assert.ok(refused.isError && /closed tab/.test(String(refused.error)));
      assert.match(resultText(await call(h.framework, 'toolsets--look')), /\[tab srv\] a closed tab, disconnected/);

      const reopened = resultText(await call(h.framework, 'toolsets--open', { server: 'srv' }));
      assert.match(reopened, /srv connected/);
      assert.match(reopened, /srv--ping\(\)/);
      assert.ok(server.peers.length >= 2 && isOpenSocket(server.peer.ws), 'a new connection');
      const again = await call(h.framework, 'toolsets--act', { tool: 'srv--ping', args: {} });
      assert.ok(again.success, again.error);

      await call(h.framework, 'toolsets--open', { server: 'srv', full: true });
      assert.ok((await headerNames(h.framework)).includes('srv--ping'), 'full again');
    } finally { await h.stop(); await server.close(); }
  });

  it('delivers a hidden tab\'s events; a closed tab has no connection to send any', async () => {
    const { server } = await pingServer();
    const h = await makeFramework({ servers: [{ id: 'srv', url: server.url, toolPrefix: 'srv' }] });
    try {
      await h.framework.start();
      await waitFor(() => h.framework.getAllTools().some((t) => t.name === 'srv--ping'), 'srv connected');
      await call(h.framework, 'toolsets--close', { server: 'srv' });
      await server.peer.request('push/event', {
        featureSet: 'srv.events', eventId: 'e1', timestamp: new Date().toISOString(),
        payload: { content: [{ type: 'text', text: 'while hidden' }] },
      });
      await waitFor(() => windowText(h.framework).some((x) => x.includes('while hidden')), 'the hidden tab\'s event stored');
      const socket = server.peer.ws;
      await call(h.framework, 'toolsets--close', { server: 'srv', disconnect: true });
      await waitFor(() => !isOpenSocket(socket), 'disconnected');
      assert.equal(server.peers.filter((p) => isOpenSocket(p.ws)).length, 0, 'no live connection to push on');
    } finally { await h.stop(); await server.close(); }
  });

  it('reconnects a closed tab with its access provider, asked afresh', async () => {
    const { server } = await pingServer();
    let asked = 0;
    const h = await makeFramework({
      servers: [{ id: 'srv', url: server.url, toolPrefix: 'srv', accessProvider: async () => { asked += 1; return `t${asked}`; } }],
    });
    try {
      await h.framework.start();
      await waitFor(() => h.framework.getAllTools().some((t) => t.name === 'srv--ping'), 'srv connected');
      const before = asked;
      await call(h.framework, 'toolsets--close', { server: 'srv', disconnect: true });
      await call(h.framework, 'toolsets--open', { server: 'srv' });
      assert.ok(asked > before, 'the provider was asked again for the new connection');
      assert.ok(isOpenSocket(server.peer.ws));
    } finally { await h.stop(); await server.close(); }
  });

  it('keeps an agent\'s tab, and a closed tab, across a restart; a configured closed tab starts unconnected', async () => {
    const { server } = await pingServer();
    const first = await makeFramework({ servers: [{ id: 'srv', url: server.url, toolPrefix: 'srv' }] });
    await first.framework.start();
    await waitFor(() => first.framework.getAllTools().some((t) => t.name === 'srv--ping'), 'srv connected');
    await call(first.framework, 'toolsets--close', { server: 'srv' });
    await first.stop(true);
    const second = await makeFramework({ dir: first.dir, servers: [{ id: 'srv', url: server.url, toolPrefix: 'srv' }] });
    try {
      await second.framework.start();
      await waitFor(() => second.framework.getAllTools().some((t) => t.name === 'srv--ping'), 'srv connected again');
      assert.ok(!(await headerNames(second.framework)).includes('srv--ping'), 'still a tab after the restart');
      await call(second.framework, 'toolsets--close', { server: 'srv', disconnect: true });
    } finally { await second.stop(true); }
    const peersBefore = server.peers.length;
    const third = await makeFramework({ dir: first.dir, servers: [{ id: 'srv', url: server.url, toolPrefix: 'srv' }] });
    try {
      await third.framework.start();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(server.peers.length, peersBefore, 'a closed tab isn\'t connected at start');
      assert.ok(!third.framework.getAllTools().some((t) => t.name === 'srv--ping'));
    } finally { await third.stop(); }

    const configured = await makeFramework({ servers: [{ id: 'cfg', url: server.url, toolPrefix: 'cfg', presentation: 'closed-tab' }] });
    try {
      await configured.framework.start();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(server.peers.length, peersBefore, 'presentation: closed-tab starts unconnected');
      assert.match(resultText(await call(configured.framework, 'toolsets--open', { server: 'cfg' })), /cfg connected/);
      await waitFor(() => configured.framework.getAllTools().some((t) => t.name === 'cfg--ping'), 'opened: connected');
      assert.ok(!(await headerNames(configured.framework)).includes('cfg--ping'), 'opened as a tab, not into the tool list');
    } finally { await configured.stop(); await server.close(); }
  });

  it('starts a server configured as a tab connected, out of the tool list', async () => {
    const { server } = await pingServer();
    const h = await makeFramework({ servers: [{ id: 'srv', url: server.url, toolPrefix: 'srv', presentation: 'tab' }] });
    try {
      await h.framework.start();
      await waitFor(() => h.framework.getAllTools().some((t) => t.name === 'srv--ping'), 'srv connected');
      assert.ok(!(await headerNames(h.framework)).includes('srv--ping'));
    } finally { await h.stop(); await server.close(); }
  });

  it('puts a hidden tool of a full server into its tab', async () => {
    const { server, calls } = await pingServer();
    const dir = mkdtempSync(join(tmpdir(), 'host-toolsets-hide-mcpl-'));
    const workspace = new WorkspaceModule({ mounts: [{ name: 'board', path: dir, mode: 'read-write', watch: 'never' }] });
    const h = await makeFramework({ dir, modules: [workspace], toolPresentation: true, servers: [{ id: 'srv', url: server.url, toolPrefix: 'srv' }] });
    try {
      await h.framework.start();
      await waitFor(() => h.framework.getAllTools().some((t) => t.name === 'srv--ping'), 'srv connected');
      await call(h.framework, 'toolsets--open', { toolset: 'settings' });
      const hid = await call(h.framework, 'toolsets--act', { tool: 'set_tool_visibility', args: { name: 'srv--ping', visible: false } });
      assert.ok(hid.success, hid.error);
      assert.ok(!(await headerNames(h.framework)).includes('srv--ping'), 'out of the tool list');
      assert.doesNotMatch(resultText(await call(h.framework, 'toolsets--look', { toolset: 'settings' })), /srv--ping/, 'not in the built-in toolset');
      assert.match(resultText(await call(h.framework, 'toolsets--open', { server: 'srv' })), /\[tab srv\] open[\s\S]*srv--ping\(\)/, 'in its server\'s tab');
      const acted = await call(h.framework, 'toolsets--act', { tool: 'srv--ping', args: {} });
      assert.ok(acted.success, acted.error);
      assert.equal(calls.length, 1);
    } finally { await h.stop(); await server.close(); }
  });

  it('is per agent; a disconnect is refused while another resident agent uses the server', async () => {
    const { server } = await pingServer();
    const h = await makeFramework({ servers: [{ id: 'srv', url: server.url, toolPrefix: 'srv' }], others: ['other'] });
    try {
      await h.framework.start();
      await waitFor(() => h.framework.getAllTools().some((t) => t.name === 'srv--ping'), 'srv connected');
      await call(h.framework, 'toolsets--close', { server: 'srv' });
      assert.ok(!(await headerNames(h.framework)).includes('srv--ping'), 'a tab for scout');
      assert.ok((await headerNames(h.framework, 'other')).includes('srv--ping'), 'still full for the other agent');
      const refused = resultText(await call(h.framework, 'toolsets--close', { server: 'srv', disconnect: true }));
      assert.match(refused, /wasn't disconnected: other has it/);
      assert.ok(isOpenSocket(server.peer.ws), 'still connected');
      await call(h.framework, 'toolsets--close', { server: 'srv' }, 'other');
      assert.match(resultText(await call(h.framework, 'toolsets--close', { server: 'srv', disconnect: true })), /disconnected/);
    } finally { await h.stop(); await server.close(); }
  });

  it('makes one connect for two opens of a closed tab at once', async () => {
    const { server } = await pingServer();
    const h = await makeFramework({ servers: [{ id: 'srv', url: server.url, toolPrefix: 'srv' }] });
    try {
      await h.framework.start();
      await waitFor(() => h.framework.getAllTools().some((t) => t.name === 'srv--ping'), 'srv connected');
      await call(h.framework, 'toolsets--close', { server: 'srv', disconnect: true });
      const before = server.peers.length;
      const [a, b] = await Promise.all([call(h.framework, 'toolsets--open', { server: 'srv' }), call(h.framework, 'toolsets--open', { server: 'srv' })]);
      assert.ok(a.success && b.success, `${a.error ?? ''} ${b.error ?? ''}`);
      assert.equal(server.peers.length, before + 1, 'one new connection');
    } finally { await h.stop(); await server.close(); }
  });

  it('ends a closed tab when its operator connects the server, and forgets it when its operator disconnects it', async () => {
    const { server } = await pingServer();
    const config: McplServerConfig = { id: 'srv', url: server.url, toolPrefix: 'srv' };
    const h = await makeFramework({ servers: [config] });
    try {
      await h.framework.start();
      await waitFor(() => h.framework.getAllTools().some((t) => t.name === 'srv--ping'), 'srv connected');
      await call(h.framework, 'toolsets--close', { server: 'srv', disconnect: true });
      await h.framework.connectMcplServer(config);
      assert.doesNotMatch(resultText(await call(h.framework, 'toolsets--look')), /closed tab/, 'not a closed tab once connected');
      await h.framework.disconnectMcplServer('srv');
      assert.doesNotMatch(resultText(await call(h.framework, 'toolsets--look')), /\[tab srv\]/, 'forgotten once removed');
    } finally { await h.stop(); await server.close(); }
  });

  it('refuses a presentation that isn\'t full, tab or closed-tab', async () => {
    await assert.rejects(
      makeFramework({ servers: [{ id: 'srv', url: 'ws://127.0.0.1:1/mcpl', presentation: 'hidden' as never }] }),
      /presentation must be "full", "tab" or "closed-tab"/,
    );
  });
});

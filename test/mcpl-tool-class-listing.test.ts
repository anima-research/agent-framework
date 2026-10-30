/**
 * MCPL RFC-008 §6: hosts show each tool's effective class and the source
 * that decided it, next to the grant. listMcplServers() carries it per
 * server; listToolClasses() covers every tool the framework offers, or one
 * agent's surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ToolDefinition, ToolResult, EventResponse } from '../src/index.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { MockMembrane } from './helpers/mock-membrane.js';

test('listMcplServers: per-server tool classes with their source (server, override, none)', () => {
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.mcplServerConfigs = new Map([['chat', { id: 'chat', command: 'node', toolPrefix: 'chat' }]]);
  framework.mcplServerRegistry = {
    getServer: () => ({
      isConnected: true, willReconnect: false, policyEstablished: true,
      grant: new CapabilityGrant(new Set(['tools']), []), droppedCapabilities: new Set(),
      manifestState: { lastValidatedRevision: null, lastFetchedAt: null, lastNegotiatedAt: null },
    }),
  };
  framework.mcplTools = [{ name: 'chat--send' }, { name: 'chat--react' }, { name: 'chat--ping' }, { name: 'other--x' }];
  framework.mcplPrefixMap = new Map([['chat', 'chat']]);
  framework.mcplToolClasses = new Map([['chat--send', ['comms']], ['chat--react', ['comms']]]);
  // The operator re-classes react: an override replaces the declaration whole.
  framework.toolClassOverrides = [['chat--react', ['body']]];

  const [chat] = (framework as AgentFramework).listMcplServers();
  assert.deepEqual(chat.toolClasses, [
    { tool: 'chat--send', serverTool: 'send', class: ['comms'], source: 'server' },
    { tool: 'chat--react', serverTool: 'react', class: ['body'], source: 'override' },
    { tool: 'chat--ping', serverTool: 'ping', class: [], source: 'none' },
  ]);
});

class ProbeModule implements Module {
  readonly name = 'probe';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    const tool = (name: string): ToolDefinition => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
    return [tool('echo'), tool('note'), tool('misc')];
  }
  async handleToolCall(): Promise<ToolResult> { return { success: true }; }
  async onProcess(): Promise<EventResponse> { return {}; }
}

test('listToolClasses: every offered tool, with host, override, built-in and unclassed sources', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'tool-class-listing-'));
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store.chronicle'),
    membrane: new MockMembrane().asMembrane(),
    agents: [],
    modules: [new ProbeModule()],
    codeExecution: { enabled: true },
    hostToolClasses: { 'probe--echo': ['files'] },
    toolClassOverrides: { 'probe--note': ['notes'] },
    syncIntervalMs: 0,
  });
  try {
    const byTool = new Map(framework.listToolClasses().map((e) => [e.tool, e]));
    assert.deepEqual(byTool.get('probe--echo'), { tool: 'probe--echo', class: ['files'], source: 'host' });
    assert.deepEqual(byTool.get('probe--note'), { tool: 'probe--note', class: ['notes'], source: 'override' });
    assert.deepEqual(byTool.get('probe--misc'), { tool: 'probe--misc', class: [], source: 'none' });
    // The framework's own built-in table classes code_execution as shell.
    assert.deepEqual(byTool.get('code_execution'), { tool: 'code_execution', class: ['shell'], source: 'host' });
    for (const entry of byTool.values()) assert.equal('serverId' in entry, false, 'no MCPL servers here');
  } finally {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('listToolClasses: per-agent surfaces, and agent-only tools in the full listing', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'tool-class-listing-agents-'));
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store.chronicle'),
    membrane: new MockMembrane().asMembrane(),
    agents: [
      { name: 'plain', model: 'test-model', systemPrompt: 'plain' },
      { name: 'routed', model: 'test-model', systemPrompt: 'routed', proseRouting: 'explicit' },
    ],
    subconscious: { enabled: true, systemPrompt: 'You watch tuned-out channels.' },
    modules: [new ProbeModule()],
    syncIntervalMs: 0,
  });
  try {
    const names = (agent?: string) => framework.listToolClasses(agent).map((e) => e.tool);
    const all = names();
    // Each tool once, even though several agents share the board.
    assert.equal(new Set(all).size, all.length);

    // prose_help exists only on explicit-mode agents' surfaces.
    assert.ok(names('routed').includes('prose_help'));
    assert.equal(names('plain').includes('prose_help'), false);
    assert.ok(all.includes('prose_help'));
    assert.deepEqual(
      framework.listToolClasses().find((e) => e.tool === 'prose_help'),
      { tool: 'prose_help', class: ['control'], source: 'host' },
    );

    // The subconscious has its own small surface, not the residents' board.
    const sub = 'Subconscious';
    assert.ok(names(sub).includes('speak_in_channel'));
    assert.equal(names(sub).includes('probe--echo'), false);
    assert.equal(names('plain').includes('speak_in_channel'), false);
    assert.ok(all.includes('speak_in_channel'));
    assert.ok(all.includes('probe--echo'));

    assert.throws(() => framework.listToolClasses('nobody'), /Unknown agent: nobody/);
  } finally {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

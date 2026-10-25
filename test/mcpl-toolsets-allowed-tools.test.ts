import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { Module } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { startScriptedServer, waitFor, type Json } from './helpers/toolset-servers.js';

type SeenResult = { toolUseId: string; content: string; isError?: boolean };

async function withGateFixture(
  check: (fixture: {
    framework: AgentFramework;
    membrane: MockMembrane;
    serverCalls: () => string[];
  }) => Promise<void>,
): Promise<void> {
  let rev = 0;
  const server = await startScriptedServer({
    advert: {
      toolHints: true,
      toolsets: { build: { title: 'Building', summary: 'Blocks', default: 'closed' } },
      featureSets: { 'arc.tools': { description: 'tools', uses: ['tools'] } },
    },
    tools: [
      { name: 'status', description: 'Status.', inputSchema: { type: 'object', properties: {} } },
      {
        name: 'peek', description: 'A dynamic tool.',
        inputSchema: { type: 'object', properties: {} },
        _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': true },
      },
    ],
    listRev: () => rev,
    on(msg, peer) {
      if (msg.method === 'toolsets/list') {
        peer.reply(msg.id, { open: [], _meta: { 'mcpl/hints': { rev: ++rev, tools: [{ name: 'peek', visible: true }] } } });
      } else if (msg.method === 'tools/call') {
        peer.reply(msg.id, { content: [{ type: 'text', text: 'SERVER RAN ' + String((msg.params as Json).name) }] });
      } else if (msg.id !== undefined) {
        peer.error(msg.id, -32601, 'Method not found');
      }
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'af-toolset-allowlist-'));
  const membrane = new MockMembrane();
  const quiet: Module = {
    name: 'quiet',
    async start() {},
    async stop() {},
    getTools: () => [],
    async handleToolCall() { return { success: false, isError: true, error: 'none' }; },
    async onProcess(event) {
      return event.type === 'external-message'
        ? { addMessages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }], requestInference: true }
        : {};
    },
  };
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'scout', model: 'test-model', systemPrompt: 'You are scout.',
        allowedTools: ['arc--status', 'toolsets--act', 'code_execution'],
      }],
      modules: [quiet],
      codeExecution: { enabled: true },
      mcplServers: [{ id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: true }],
    });
    await framework.start();
    await waitFor(() => framework!.getAllTools().some(tool => tool.name === 'arc--status'), 'static tool listed');
    await waitFor(() => server.received.some(message => message.method === 'toolsets/list'), 'dynamic hints loaded');
    const serverCalls = () => server.received
      .filter(message => message.method === 'tools/call')
      .map(message => String((message.params as Json).name));
    await check({ framework, membrane, serverCalls });
  } finally {
    await framework?.stop();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function resultsOf(membrane: MockMembrane): SeenResult[] {
  return (membrane.lastStream?.receivedToolResults.flat() ?? []) as SeenResult[];
}

function assertOnlyNamedToolRan(results: SeenResult[], serverCalls: string[]): void {
  const permitted = results.find(result => result.toolUseId === 'gate-status');
  const denied = results.find(result => result.toolUseId === 'gate-act');
  assert.ok(permitted, 'the permitted control answered');
  assert.equal(Boolean(permitted.isError), false);
  assert.match(permitted.content, /SERVER RAN status/);
  assert.ok(denied, 'the dynamic target answered');
  assert.deepEqual(serverCalls, ['status'], 'only the permitted tool reached the server');
  assert.equal(denied.isError, true);
  assert.match(denied.content, /arc--peek.*not permitted.*allowedTools/);
}

function toolCalls() {
  return [
    { type: 'tool_use' as const, id: 'gate-status', name: 'arc--status', input: {} },
    { type: 'tool_use' as const, id: 'gate-act', name: 'toolsets--act', input: { server: 'arc', tool: 'peek', args: {} } },
  ];
}

test('a model calling act cannot run a dynamic tool left out of its allowedTools', async () => {
  await withGateFixture(async ({ framework, membrane, serverCalls }) => {
    membrane.pushResponse(createMockResponse(toolCalls(), 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'model done' }]));
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as never);
    await framework.runUntilIdle();
    const cm = framework.getAgent('scout')!.getContextManager();
    await waitFor(() => cm.getAllMessages().some(message => JSON.stringify(message.content).includes('model done')), 'model turn settled');
    assertOnlyNamedToolRan(resultsOf(membrane), serverCalls());
  });
});

test('a code_execution script calling act cannot run a dynamic tool left out of its allowedTools', async () => {
  await withGateFixture(async ({ framework, membrane, serverCalls }) => {
    const code = [
      'const control = await tools["arc--status"]({});',
      'let outcome = "unexpected target success";',
      'try { await tools["toolsets--act"]({ server: "arc", tool: "peek", args: {} }); }',
      'catch (error) { outcome = String(error.message); }',
      'text(control.content[0].text + "\\n" + outcome);',
    ].join('\n');
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'script', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'script done' }]));
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as never);
    await framework.runUntilIdle();
    const cm = framework.getAgent('scout')!.getContextManager();
    await waitFor(() => cm.getAllMessages().some(message => JSON.stringify(message.content).includes('script done')), 'script turn settled');
    const outer = resultsOf(membrane).find(result => result.toolUseId === 'script');
    assert.ok(outer, 'the script answered its model');
    assert.equal(Boolean(outer.isError), false, outer.content);
    assert.match(outer.content, /SERVER RAN status/);
    assert.deepEqual(serverCalls(), ['status'], 'only the permitted script call reached the server');
    assert.match(outer.content, /arc--peek.*not permitted.*allowedTools/);
  });
});

test('an ephemeral agent calling act cannot run a dynamic tool left out of its allowedTools', async () => {
  await withGateFixture(async ({ framework, membrane, serverCalls }) => {
    const created = await framework.createEphemeralAgent({
      name: 'worker', model: 'test-model', systemPrompt: 'Do the task.',
      allowedTools: ['arc--status', 'toolsets--act'],
    });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
    membrane.pushResponse(createMockResponse(toolCalls(), 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ephemeral done' }]));
    const run = framework.runEphemeralToCompletion(created.agent, created.contextManager);
    await framework.runUntilIdle();
    await run;
    assertOnlyNamedToolRan(resultsOf(membrane), serverCalls());
  });
});

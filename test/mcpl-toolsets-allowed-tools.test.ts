import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { Module } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { startScriptedServer, waitFor, resultText, windowText, type Json } from './helpers/toolset-servers.js';

type SeenResult = { toolUseId: string; content: string; isError?: boolean };

async function withGateFixture(
  check: (fixture: {
    framework: AgentFramework;
    membrane: MockMembrane;
    serverCalls: () => string[];
  }) => Promise<void>,
  options: { policy?: { enabledTools?: string[]; disabledTools?: string[] }; allowedTools?: string[] } = {},
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
        allowedTools: options.allowedTools ?? ['arc--status', 'toolsets--act', 'code_execution'],
      }],
      modules: [quiet],
      codeExecution: { enabled: true },
      mcplServers: [{ id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: true, ...options.policy }],
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

test('operator tool policy controls dynamic visibility and act calls', async (t) => {
  const scenarios: Array<{
    name: string;
    policy?: { enabledTools?: string[]; disabledTools?: string[] };
    permitted: boolean;
  }> = [
    { name: 'permitted dynamic tool', permitted: true },
    { name: 'enabledTools omits dynamic tool', policy: { enabledTools: ['status'] }, permitted: false },
    { name: 'disabledTools denies dynamic tool', policy: { disabledTools: ['peek'] }, permitted: false },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      await withGateFixture(async ({ framework, membrane, serverCalls }) => {
        const look = await framework.executeToolCall({
          id: 'policy-look', name: 'toolsets--look', input: { server: 'arc' }, callerAgentName: 'scout',
        });
        assert.equal(Boolean(look.isError), false, resultText(look));
        const listedByLook = /peek\(\)/.test(resultText(look));
        const announced = windowText(framework).some(text => /peek\(\)/.test(text));

        membrane.pushResponse(createMockResponse(toolCalls(), 'tool_use'));
        membrane.pushResponse(createMockResponse([{ type: 'text', text: 'policy done' }]));
        framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as never);
        await framework.runUntilIdle();
        const cm = framework.getAgent('scout')!.getContextManager();
        await waitFor(() => cm.getAllMessages().some(message => JSON.stringify(message.content).includes('policy done')), 'policy turn settled');
        const results = resultsOf(membrane);
        const status = results.find(result => result.toolUseId === 'gate-status');
        const target = results.find(result => result.toolUseId === 'gate-act');
        assert.ok(status, 'the permitted static control answered');
        assert.match(status.content, /SERVER RAN status/);
        assert.ok(target, 'the dynamic call answered the model');
        const callsAfterModel = serverCalls();

        const direct = await framework.executeToolCall({
          id: 'policy-programmatic', name: 'toolsets--act',
          input: { server: 'arc', tool: 'peek', args: {} }, callerAgentName: 'scout',
        });
        const observed = {
          listedByLook,
          announced,
          modelRefused: Boolean(target.isError),
          modelReturnedTarget: /SERVER RAN peek/.test(target.content),
          callsAfterModel,
          programmaticRefused: Boolean(direct.isError),
          programmaticReturnedTarget: /SERVER RAN peek/.test(resultText(direct)),
          allServerCalls: serverCalls(),
        };
        assert.deepEqual(observed, scenario.permitted ? {
          listedByLook: true, announced: true,
          modelRefused: false, modelReturnedTarget: true, callsAfterModel: ['status', 'peek'],
          programmaticRefused: false, programmaticReturnedTarget: true, allServerCalls: ['status', 'peek', 'peek'],
        } : {
          listedByLook: false, announced: false,
          modelRefused: true, modelReturnedTarget: false, callsAfterModel: ['status'],
          programmaticRefused: true, programmaticReturnedTarget: false, allServerCalls: ['status'],
        }, scenario.name);
      }, {
        policy: scenario.policy,
        allowedTools: ['arc--status', 'arc--peek', 'toolsets--act', 'toolsets--look'],
      });
    });
  }
});

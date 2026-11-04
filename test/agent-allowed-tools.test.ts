import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/framework.js';
import type { AgentConfig, Module, ModuleContext, ToolCall, ToolResult } from '../src/types/index.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { ToolLifecycleEmitter, type ToolLifecycleParams } from '../src/mcpl/tool-lifecycle.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';
import { scriptCall } from './helpers/script-call.js';

async function harness(config: Partial<AgentConfig>, probeHandler?: (call: ToolCall) => Promise<ToolResult>, deferModule = false) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-allowed-tools-'));
  const membrane = new MockMembrane();
  const effects: ToolCall[] = [];
  let moduleContext: ModuleContext;
  const module: Module = {
    name: 'probe',
    async start(ctx) { moduleContext = ctx; },
    async stop() {},
    getTools: () => ['allowed', 'denied'].map((name) => ({
      name, description: 'Inert dispatch counter', inputSchema: { type: 'object', properties: {} },
    })),
    getUtilities: () => ['allowed_util', 'denied_util'].map((name) => ({
      name, description: 'Inert utility counter', inputSchema: { type: 'object', properties: {} },
    })),
    async handleToolCall(call) {
      effects.push(call);
      return probeHandler ? await probeHandler(call) : { success: true, data: 'executed' };
    },
    async onProcess(event) {
      return event.type === 'external-message'
        ? { addMessages: [{ participant: 'user', content: [{ type: 'text', text: 'Run probe' }] }], requestInference: true }
        : {};
    },
  };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'Test', ...config }],
    modules: deferModule ? [] : [module], syncIntervalMs: 0, codeExecution: { enabled: true },
    conversations: { templateAgent: 'assistant', bind: { channel: 'mention' } },
  });
  const traces: Array<Record<string, unknown>> = [];
  framework.onTrace((event) => traces.push(event as unknown as Record<string, unknown>));
  const lifecycle: ToolLifecycleParams[] = [];
  const emitter = new ToolLifecycleEmitter({
    observers: () => [{
      id: 'observer', grant: new CapabilityGrant(new Set(['toolLifecycle.observe']), []),
      toolObserveFilter: null, sendToolLifecycle: (event) => lifecycle.push(event),
    }],
    configFor: () => undefined, describe: () => ({ class: [] }),
  });
  // Use the real emitter with an in-memory observer, without an MCPL process.
  const internal = framework as unknown as {
    toolLifecycleEmitter: ToolLifecycleEmitter;
    getToolsForAgent(name: string): ReturnType<AgentFramework['getAllTools']>;
    dispatchScriptToolCall(agent: string, tool: string, input: Record<string, unknown>): Promise<ToolResult>;
  };
  internal.toolLifecycleEmitter = emitter;
  return {
    framework, membrane, effects, traces, lifecycle, emitter, internal, module,
    moduleCall: (call: ToolCall) => moduleContext.callTool(call),
    async turn(calls: ToolCall[]) {
      membrane.pushResponse(createMockResponse(calls.map((call) => ({
        type: 'tool_use', id: call.id, name: call.name, input: call.input as Record<string, unknown>,
      })), 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done' }]));
      framework.pushEvent({ type: 'external-message', source: 'probe', content: 'Run probe', metadata: {} });
      await framework.runUntilIdle();
      return membrane.lastStream!.receivedToolResults[0] as Array<{ toolUseId: string; content: string; isError?: boolean }>;
    },
    async close() { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const generic: ToolCall = { id: 'generic-denied', name: 'probe--denied', input: {} };
const builtin: ToolCall = {
  id: 'builtin-denied', name: 'agent_settings',
  input: { action: 'update', same_round_think_text_policy: 'private' },
};

for (const allowedTools of [['probe--allowed'], []]) {
  for (const calls of [[generic], [builtin]]) {
    test(`normal model dispatch denies ${calls[0].name} with ${JSON.stringify(allowedTools)}`, async () => {
      const h = await harness({ allowedTools });
      try {
        const before = h.framework.getAgentRuntimeSettings('assistant');
        const results = await h.turn(calls);
        assert.equal(h.effects.length, 0, 'unlisted generic tool must have zero effects');
        assert.deepEqual(h.framework.getAgentRuntimeSettings('assistant'), before, 'unlisted builtin must have zero effects');
        assert.deepEqual(results.map((r) => r.toolUseId), calls.map((c) => c.id));
        for (const result of results) {
          assert.equal(result.isError, true);
          assert.match(result.content, /not permitted.*allowedTools/);
        }
        assert.deepEqual(h.lifecycle, [], 'refused calls must emit no RFC-007 lifecycle events');
        assert.equal(h.emitter.openCount, 0);
        for (const call of calls) {
          const events = h.traces.filter((e) => e.callId === call.id && String(e.type).startsWith('tool:'));
          assert.equal(events.length, 1);
          assert.equal(events[0].type, 'tool:failed');
          assert.equal(events[0].tool, call.name);
        }
        const compiled = await h.framework.getAgent('assistant')!.compileContext();
        const blocks = compiled.messages.flatMap((m) => m.content);
        for (const call of calls) {
          assert.ok(blocks.some((b) => b.type === 'tool_use' && b.id === call.id));
          assert.ok(blocks.some((b) => b.type === 'tool_result' && b.toolUseId === call.id && b.isError));
        }
      } finally { await h.close(); }
    });
  }
}

for (const allowedTools of [undefined, 'all', ['probe--denied', 'agent_settings']] as Array<AgentConfig['allowedTools']>) {
  test(`allowed model calls retain effects and paired results: ${JSON.stringify(allowedTools)}`, async () => {
    const h = await harness({ allowedTools });
    try {
      const results = await h.turn([generic, builtin]);
      assert.equal(h.effects.length, 1);
      assert.equal(h.framework.getAgentRuntimeSettings('assistant').sameRoundThinkTextPolicy, 'private');
      assert.deepEqual(results.map((r) => r.toolUseId).sort(), [generic.id, builtin.id].sort());
      assert.ok(results.every((r) => !r.isError));
      assert.deepEqual(h.lifecycle.map((e) => e.phase).sort(), ['completed', 'completed', 'started', 'started']);
      assert.equal(h.emitter.openCount, 0);
    } finally { await h.close(); }
  });
}

for (const permitted of [false, true]) {
  test(`explicit prose helper follows current allowlist: ${permitted}`, async () => {
    const h = await harness({ allowedTools: permitted ? ['prose_help'] : [], proseRouting: 'explicit' });
    try {
      assert.equal(h.framework.listToolClasses('assistant').some(t => t.tool === 'prose_help'), permitted);
      const [result] = await h.turn([{ id: 'help', name: 'prose_help', input: {} }]);
      assert.equal(result.toolUseId, 'help');
      assert.equal(Boolean(result.isError), !permitted);
      assert.match(result.content, permitted ? />>/ : /not permitted.*allowedTools/);
      if (permitted) {
        // The reference names the `>>skip_reply` envelope, which no list refuses, and not the
        // skip_reply tool, which this agent's list doesn't name.
        assert.match(result.content, />>skip_reply/);
        assert.doesNotMatch(result.content, /skip_reply tool/);
      }
    } finally { await h.close(); }
  });
}

test('shared script dispatch enforces the resident list and resolves its real event waiter', async () => {
  const h = await harness({ allowedTools: ['probe--allowed'] });
  try {
    const before = h.framework.getAgentRuntimeSettings('assistant');
    for (const call of [generic, builtin, { id: 'allowed', name: 'probe--allowed', input: {} }]) {
      const pending = h.internal.dispatchScriptToolCall('assistant', call.name, call.input as Record<string, unknown>);
      await h.framework.runUntilIdle();
      const result = await pending;
      assert.equal(result.success, call.name === 'probe--allowed');
      if (!result.success) {
        assert.equal(result.isError, true);
        assert.match(result.error!, /not permitted.*allowedTools/);
      }
    }
    assert.deepEqual(h.effects.map((c) => c.name), ['allowed']);
    assert.deepEqual(h.framework.getAgentRuntimeSettings('assistant'), before);
  } finally { await h.close(); }
});

test('a model-issued script cannot reach unlisted inner generic or builtin calls, nor can a forged call', async () => {
  const h = await harness({ allowedTools: ['code_execution', 'probe--allowed'] });
  try {
    const before = h.framework.getAgentRuntimeSettings('assistant');
    const [result] = await h.turn([{
      id: 'script', name: 'code_execution', input: { code: [
        'const seen = [];',
        'for (const name of ["probe--denied", "agent_settings"]) {',
        '  try { await tools[name]({ action: "update", same_round_think_text_policy: "private" }); seen.push("ran " + name); }',
        '  catch (error) { seen.push(error.message); }',
        '}',
        // The host call the prelude closes over isn't the script's to reach.
        'seen.push("host: " + typeof globalThis.__host, "tools: " + ALL_TOOLS.map((t) => t.name).join());',
        'await tools["probe--allowed"]({});',
        'text(seen.join("\\n"));',
      ].join('\n') },
    }]);
    assert.equal(result.toolUseId, 'script');
    assert.ok(!result.isError, result.content);
    assert.match(result.content, /^Script s\d+-[0-9a-z]{4} finished\./);
    assert.equal((result.content.match(/is not one of your tools\..*Nothing was sent\./g) ?? []).length, 2, result.content);
    assert.match(result.content, /host: undefined\ntools: probe--allowed\n/);
    // A child that sent such a call anyway is refused by the host's dispatch.
    for (const name of ['probe--denied', 'agent_settings']) {
      // Its answer comes through the event loop, which this framework runs by hand.
      const pending = scriptCall(h.framework, 'assistant', name, { action: 'update', same_round_think_text_policy: 'private' });
      await h.framework.runUntilIdle();
      const forged = await pending;
      assert.equal(forged.refused, true, name);
      assert.match(forged.refused ? forged.message : '', /not permitted.*allowedTools/);
    }
    assert.deepEqual(h.effects.map((c) => c.name), ['allowed']);
    assert.deepEqual(h.framework.getAgentRuntimeSettings('assistant'), before);
    assert.deepEqual(h.lifecycle.filter(event => ['probe--denied', 'agent_settings'].includes(event.tool)), []);
    for (const tool of ['code_execution', 'probe--allowed']) {
      assert.deepEqual(h.lifecycle.filter(event => event.tool === tool).map(event => event.phase), ['started', 'completed']);
    }
    assert.equal(h.emitter.openCount, 0);
    assert.equal((h.emitter as unknown as { calls: Map<string, unknown> }).calls.size, 0);
    assert.equal((h.framework as unknown as { scriptToolWaiters: Map<string, unknown> }).scriptToolWaiters.size, 0);
  } finally { await h.close(); }
});

test('unregistered programmatic ephemeral script callers retain their full surface', async () => {
  const h = await harness({ allowedTools: [] });
  try {
    const pending = h.framework.executeToolCall({
      id: 'ephemeral-script', name: 'code_execution', callerAgentName: 'unregistered-ephemeral',
      input: { code: 'await tools["probe--denied"]({});' },
    });
    // The script's child sends its inner call after it starts.
    const processing = setInterval(() => { void h.framework.runUntilIdle(); }, 10);
    try {
      const result = await pending;
      assert.equal(result.success, true, result.error);
      assert.match((result.data as Array<{ text: string }>)[0]!.text, /^Script s\d+-[0-9a-z]{4} finished\./);
      assert.equal(h.effects.length, 1);
    } finally { clearInterval(processing); }
  } finally { await h.close(); }
});

for (const call of [generic, { id: 'public-script', name: 'code_execution', input: { code: 'text("forbidden");' } }]) {
  test(`a registered agent's programmatic call (executeToolCall) of ${call.name} it may not use is a failure before effects`, async () => {
    const h = await harness({ allowedTools: [] });
    try {
      const result = await h.framework.executeToolCall({ ...call, callerAgentName: 'assistant' });
      assert.equal(result.success, false);
      assert.equal(result.isError, true);
      assert.match(result.error!, /not permitted.*allowedTools, so the call didn't run\./);
      // Off the dispatcher no RFC-007 call opened, so it isn't a refusal.
      assert.equal(result.refused, undefined);
      assert.equal(h.effects.length, 0);
      assert.deepEqual(h.lifecycle, []);
      const traced = h.traces.filter((e) => e.callId === call.id && e.type === 'tool:failed');
      assert.equal(traced.length, 1);
      // The trace names the call, where it was decided, and why.
      assert.equal(traced[0]!.tool, call.name);
      assert.equal(traced[0]!.module, 'framework');
      assert.match(String(traced[0]!.error), /not permitted.*allowedTools, so the call didn't run\./);
      // A refused code_execution must not even start a script.
      const scripts = (h.framework as unknown as { codeExecution: { scripts: { list(agent: string): unknown[] } } }).codeExecution.scripts;
      assert.deepEqual(scripts.list('assistant'), []);
    } finally { await h.close(); }
  });
}

test('trusted module closure bypasses resident restrictions even with a registered caller identity', async () => {
  const h = await harness({ allowedTools: [] });
  try {
    const result = await h.moduleCall({ ...generic, callerAgentName: 'assistant' });
    assert.equal(result.success, true);
    assert.deepEqual(h.effects.map((c) => c.name), ['denied']);
  } finally { await h.close(); }
});

// Same channel capture contract as explicit-prose-routing.test.ts.
function captureRouting(framework: AgentFramework) {
  const routed: string[] = [];
  const registry: Record<string, unknown> = {
    handleChannelToolCall: async () => ({ success: true, data: 'ok' }),
    routeSpeech: async (_agent: string, text: string) => { routed.push(text); return { delivered: true, serverId: 'stub', channelId: 'world:commons' }; },
    resolveLocus: () => ({ serverId: 'stub', channelId: 'world:commons' }), getDefaultPublishChannel: () => null,
    isChannelOpen: () => true, getDescriptor: () => undefined, getChannelTools: () => [],
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(registry, {
    get: (target, prop: string) => prop in target ? target[prop] : () => undefined,
  });
  return routed;
}

/**
 * XML tool mode: no round carries its verbatim roundContent, so none is
 * routed live, and the turn-end completion holds the cumulative tool round,
 * its prose, its call and its result, as XML mode parses them, before the
 * final text.
 */
function asXmlTurn(membrane: MockMembrane, call: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }): void {
  const streamYielding = membrane.streamYielding.bind(membrane);
  membrane.streamYielding = (request, options) => {
    const stream = streamYielding(request, options);
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = async function* () {
      for await (const event of { [Symbol.asyncIterator]: iterate }) {
        if (event.type === 'tool-calls') {
          yield { ...event, context: { ...event.context, roundContent: undefined } };
        } else if (event.type === 'complete') {
          const round = [{ type: 'text' as const, text: 'Public round prose' }, call, { type: 'tool_result' as const, toolUseId: call.id, content: 'result' }];
          yield { ...event, response: { ...event.response, content: [...round, ...event.response.content] } };
        } else yield event;
      }
    };
    return stream;
  };
}

for (const fallback of [false, true]) {
  test(`${fallback ? 'fallback' : 'native'}: a skip_reply refused at dispatch silences nothing after its round, as one allowedTools refuses`, async () => {
    const h = await harness({ allowedTools: ['skip_reply'], denyToolsAtDispatch: ['skip_reply'], sameRoundThinkTextPolicy: 'private' });
    try {
      const routed = captureRouting(h.framework);
      const call = { type: 'tool_use' as const, id: 'disposition', name: 'skip_reply', input: { reason: 'test' } };
      if (fallback) asXmlTurn(h.membrane, call);
      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public round prose' }, call], 'tool_use'));
      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public trailing prose' }]));
      h.framework.pushEvent({ type: 'external-message', source: 'probe', content: 'Run probe', metadata: {} });
      await h.framework.runUntilIdle();
      assert.ok(routed.includes('Public trailing prose'), 'a refused call silences nothing after its round');
    } finally { await h.close(); }
  });
}

for (const fallback of [false, true]) {
  for (const name of ['skip_reply', 'think', 'channel_publish']) {
    for (const permitted of [false, true]) {
      test(`${fallback ? 'fallback' : 'native'} prose disposition ${permitted ? 'honors permitted' : 'of a refused'} ${name}`, async () => {
        const h = await harness({ allowedTools: permitted ? [name] : [], sameRoundThinkTextPolicy: 'private' });
        try {
          const routed = captureRouting(h.framework);
          const call = { type: 'tool_use' as const, id: 'disposition', name, input: { reason: 'test', content: 'test' } };
          if (fallback) asXmlTurn(h.membrane, call);
          h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public round prose' }, call], 'tool_use'));
          h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public trailing prose' }]));
          h.framework.pushEvent({ type: 'external-message', source: 'probe', content: 'Run probe', metadata: {} });
          await h.framework.runUntilIdle();
          const results = h.membrane.lastStream!.receivedToolResults[0] as Array<{ isError?: boolean; content: string }>;
          if (!permitted) {
            assert.equal(results[0].isError, true);
            assert.match(results[0].content, /not permitted.*allowedTools/);
            assert.ok(routed.includes('Public trailing prose'), 'a refused call silences nothing after its round');
            if (name === 'channel_publish') {
              // A refused send posted nothing, so it has nothing to keep from repeating.
              assert.ok(routed.includes('Public round prose'), "a refused send's round goes out");
            } else if (name === 'skip_reply') {
              // The model's choice to keep its words private holds without the call's effect.
              assert.ok(!routed.includes('Public round prose'),
                `a refused skip_reply keeps its own round private${fallback ? ', dropped by its place at turn end' : ''}`);
            } else if (!fallback) {
              // Where rounds are routed live, the private same-round policy
              // reads a refused think as it reads a permitted one.
              assert.ok(!routed.includes('Public round prose'), 'a refused think keeps its round private under the private same-round policy');
            }
          } else if (name === 'think') {
            assert.ok(routed.includes('Public trailing prose'));
            if (!fallback) assert.ok(!routed.includes('Public round prose'), 'permitted private think retains same-round policy');
          } else {
            assert.deepEqual(routed, [], 'permitted silencing calls retain prose disposition');
          }
        } finally { await h.close(); }
      });
    }
  }
}

for (const fallback of [false, true]) {
  test(`${fallback ? 'fallback' : 'native'}: a refused skip_reply another module names (probe--skip_reply) keeps its round private by its bare name, and silences nothing after it`, async () => {
    const h = await harness({ allowedTools: [] });
    try {
      const routed = captureRouting(h.framework);
      const call = { type: 'tool_use' as const, id: 'namespaced', name: 'probe--skip_reply', input: { reason: 'test' } };
      if (fallback) asXmlTurn(h.membrane, call);
      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public round prose' }, call], 'tool_use'));
      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public trailing prose' }]));
      h.framework.pushEvent({ type: 'external-message', source: 'probe', content: 'Run probe', metadata: {} });
      await h.framework.runUntilIdle();
      const results = h.membrane.lastStream!.receivedToolResults[0] as Array<{ isError?: boolean; content: string }>;
      assert.equal(results[0].isError, true);
      assert.match(results[0].content, /not permitted.*allowedTools/);
      assert.ok(!routed.includes('Public round prose'), 'the round that calls it stays private, as for skip_reply');
      assert.ok(routed.includes('Public trailing prose'), 'and what follows goes out');
    } finally { await h.close(); }
  });
}


test("XML tool mode: a refused think's round goes as a permitted think's does", async () => {
  const dispositions: string[][] = [];
  for (const permitted of [true, false]) {
    const h = await harness({ allowedTools: permitted ? ['think'] : [], sameRoundThinkTextPolicy: 'private' });
    try {
      const routed = captureRouting(h.framework);
      const call = { type: 'tool_use' as const, id: 'think', name: 'think', input: { content: 'test' } };
      asXmlTurn(h.membrane, call);
      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public round prose' }, call], 'tool_use'));
      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public trailing prose' }]));
      h.framework.pushEvent({ type: 'external-message', source: 'probe', content: 'Run probe', metadata: {} });
      await h.framework.runUntilIdle();
      const results = h.membrane.lastStream!.receivedToolResults[0] as Array<{ isError?: boolean }>;
      assert.equal(results[0].isError === true, !permitted);
      dispositions.push(routed);
    } finally { await h.close(); }
  }
  assert.ok(dispositions[0].includes('Public round prose'), "a permitted think's round goes out in XML tool mode, where no round is routed live");
  assert.deepEqual(dispositions[1], dispositions[0], 'the refusal changes nothing about which prose goes out');
});

for (const skipName of ['skip_reply', 'probe--skip_reply']) test(`explicit prose routing: a refused ${skipName}'s round stays private, and what follows goes on as unprefixed prose does`, async () => {
  const h = await harness({ allowedTools: [], proseRouting: 'explicit' });
  try {
    const routed = captureRouting(h.framework);
    const bounced: number[] = [];
    h.framework.onTrace((e) => {
      const ev = e as { type: string; source?: string };
      if (ev.type === 'message:added' && ev.source === 'prose-bounce') bounced.push(1);
    });
    h.membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Private round prose' },
      { type: 'tool_use', id: 'skip', name: skipName, input: { reason: 'quiet' } },
    ], 'tool_use'));
    h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Unprefixed trailing prose' }]));
    // A bounce wakes the agent again, and a stream takes the responses queued
    // when it starts: answer each later turn privately as it starts.
    let turns = 0;
    h.framework.onTrace((e) => {
      if ((e as { type: string }).type !== 'inference:started') return;
      if (++turns >= 2) h.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply\nnoted' }]));
    });
    const firstTurn: Array<NonNullable<typeof h.membrane.lastStream>> = [];
    const streamYielding = h.membrane.streamYielding.bind(h.membrane);
    h.membrane.streamYielding = (request, options) => {
      const stream = streamYielding(request, options);
      if (firstTurn.length === 0) firstTurn.push(h.membrane.lastStream!);
      return stream;
    };
    h.framework.pushEvent({ type: 'external-message', source: 'probe', content: 'Run probe', metadata: {} });
    await h.framework.runUntilIdle();
    const results = firstTurn[0]!.receivedToolResults[0] as Array<{ isError?: boolean }>;
    assert.equal(results[0].isError, true);
    assert.deepEqual(routed, [], 'nothing is delivered');
    assert.equal(bounced.length, 1, "only the trailing round's unprefixed prose bounces; the refused skip_reply's round stays in context");
  } finally { await h.close(); }
});

test("a refused skip_reply beside a refused send keeps its round private, and neither silences what follows", async () => {
  const h = await harness({ allowedTools: [] });
  try {
    const routed = captureRouting(h.framework);
    h.membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Public round prose' },
      { type: 'tool_use', id: 'skip', name: 'skip_reply', input: { reason: 'quiet' } },
      { type: 'tool_use', id: 'send', name: 'channel_publish', input: { content: 'never posted' } },
    ], 'tool_use'));
    h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public trailing prose' }]));
    h.framework.pushEvent({ type: 'external-message', source: 'probe', content: 'Run probe', metadata: {} });
    await h.framework.runUntilIdle();
    const results = h.membrane.lastStream!.receivedToolResults[0] as Array<{ isError?: boolean }>;
    assert.deepEqual(results.map((r) => r.isError), [true, true]);
    assert.ok(!routed.includes('Public round prose'), 'the skip_reply keeps its round private');
    assert.ok(routed.includes('Public trailing prose'), 'the refused send silences nothing after the round');
  } finally { await h.close(); }
});

for (const fallback of [false, true]) {
  test(`${fallback ? 'fallback' : 'native'}: a skip_reply the list doesn't name, asking for a wake on a host with no EventGate, is refused by the list first, and its round stays private`, async () => {
    const h = await harness({ allowedTools: [] });
    try {
      const routed = captureRouting(h.framework);
      assert.equal((h.framework as unknown as { eventGate?: unknown }).eventGate ?? undefined, undefined, 'no EventGate');
      const call = { type: 'tool_use' as const, id: 'wake', name: 'skip_reply', input: { reason: 'later', wake_in_seconds: 60 } };
      if (fallback) asXmlTurn(h.membrane, call);
      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public round prose' }, call], 'tool_use'));
      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public trailing prose' }]));
      h.framework.pushEvent({ type: 'external-message', source: 'probe', content: 'Run probe', metadata: {} });
      await h.framework.runUntilIdle();
      const results = h.membrane.lastStream!.receivedToolResults[0] as Array<{ isError?: boolean; content: string }>;
      assert.equal(results[0].isError, true);
      assert.match(results[0].content, /not permitted.*allowedTools/, 'the permission refusal comes first');
      assert.ok(!routed.includes('Public round prose'), 'its round stays private');
      assert.ok(routed.includes('Public trailing prose'), 'and silences nothing after it');
    } finally { await h.close(); }
  });
}

for (const name of ['set_tool_visibility', 'set_tool_description']) {
  test(`presentation tools obey allowlist on model, script and registered public routes: ${name}`, async () => {
    const h = await harness({ allowedTools: ['probe--allowed'] });
    try {
      const input = name === 'set_tool_visibility'
        ? { name: 'probe--allowed', visible: false }
        : { name: 'probe--allowed', description: 'Changed' };
      const call = { id: 'presentation-denied', name, input, callerAgentName: 'assistant' };
      const [model] = await h.turn([call]);
      assert.equal(model.isError, true);
      assert.match(model.content, /not permitted.*allowedTools/);
      const pending = h.internal.dispatchScriptToolCall('assistant', name, input);
      await h.framework.runUntilIdle();
      const script = await pending;
      assert.equal(script.isError, true);
      assert.match(script.error!, /not permitted.*allowedTools/);
      const direct = await h.framework.executeToolCall(call);
      assert.equal(direct.isError, true);
      assert.match(direct.error!, /not permitted.*allowedTools/);
      assert.deepEqual(h.lifecycle, [], 'denied presentation calls must not dispatch');
      assert.equal(h.framework.inspectToolPresentation('assistant'), null);
    } finally { await h.close(); }
  });
}

/** Opens the host's built-in toolset, where module utilities are, for the agent. */
async function openSettings(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
  const opened = await h.framework.executeToolCall({ id: 'open-settings', name: 'toolsets--open', input: { toolset: 'settings' }, callerAgentName: 'assistant' });
  assert.equal(opened.success, true, opened.error);
}

for (const route of ['model', 'public', 'script'] as const) {
  test(`act checks the called utility's own name on the ${route} route`, async () => {
    const h = await harness({ allowedTools: ['toolsets--open', 'toolsets--act', 'toolsets--look', 'toolsets--close', 'probe--allowed_util'] });
    const input = { tool: 'probe--denied_util', args: {} };
    try {
      await openSettings(h);
      if (route === 'model') {
        const [result] = await h.turn([{ id: 'utility-denied', name: 'toolsets--act', input }]);
        assert.equal(result.isError, true); assert.match(result.content, /not permitted.*allowedTools/);
        // Refused at dispatch as a direct call of the utility is: traced as
        // that tool's failure, and never opened, so no RFC-007 event.
        const terminals = h.traces.filter(event => event.callId === 'utility-denied' &&
          ['tool:failed', 'tool:completed'].includes(event.type as string));
        assert.deepEqual(terminals.map(event => [event.type, event.tool]), [['tool:failed', 'probe--denied_util']]);
        assert.deepEqual(h.lifecycle, []);
        assert.equal(h.emitter.openCount, 0);
        assert.equal((h.emitter as unknown as { calls: Map<string, unknown> }).calls.size, 0);
        assert.equal((h.framework as unknown as { scriptToolWaiters: Map<string, unknown> }).scriptToolWaiters.size, 0);
      } else if (route === 'public') {
        const result = await h.framework.executeToolCall({ id: 'utility-denied', name: 'toolsets--act', input, callerAgentName: 'assistant' });
        assert.equal(result.isError, true); assert.match(result.error!, /not permitted.*allowedTools/);
      } else {
        const pending = h.internal.dispatchScriptToolCall('assistant', 'toolsets--act', input);
        const processing = setInterval(() => { void h.framework.runUntilIdle(); }, 5);
        try {
          const result = await pending;
          assert.equal(result.isError, true); assert.match(result.error!, /not permitted.*allowedTools/);
        } finally { clearInterval(processing); }
      }
      assert.deepEqual(h.effects, []);
    } finally { await h.close(); }
  });
}

for (const allowedTools of [['toolsets--open', 'toolsets--act', 'toolsets--look', 'toolsets--close', 'probe--allowed_util'], 'all'] as AgentConfig['allowedTools'][]) {
  test(`the built-in toolset lists and calls only the utilities the agent may call: ${JSON.stringify(allowedTools)}`, async () => {
    const h = await harness({ allowedTools });
    const call = (name: string, input: unknown) => h.framework.executeToolCall({ id: 'utility', name, input: input as Record<string, unknown>, callerAgentName: 'assistant' });
    try {
      const looked = await call('toolsets--look', { toolset: 'settings' }); assert.equal(looked.success, true, looked.error);
      const expected = allowedTools === 'all' ? ['probe--allowed_util', 'probe--denied_util'] : ['probe--allowed_util'];
      for (const name of ['probe--allowed_util', 'probe--denied_util']) {
        assert.equal(String(looked.data).includes(`${name}(`), expected.includes(name), `${name} listed only where callable`);
      }
      await openSettings(h);
      for (const name of expected) assert.equal((await call('toolsets--act', { tool: name, args: {} })).success, true);
      assert.deepEqual(h.effects.map(c => 'probe--' + c.name), expected);
    } finally { await h.close(); }
  });
}

test('trusted module utility call retains its authority with a restricted caller name', async () => {
  const h = await harness({ allowedTools: [] });
  try {
    const result = await h.moduleCall({ id: 'trusted-utility', name: 'probe--denied_util', input: {}, callerAgentName: 'assistant' });
    assert.equal(result.success, true); assert.deepEqual(h.effects.map(c => c.name), ['denied_util']);
  } finally { await h.close(); }
});

test('refused inner script call clears lifecycle and its waiter without execution', async () => {
  const h = await harness({ allowedTools: [] });
  try {
    const pending = h.internal.dispatchScriptToolCall('assistant', generic.name, {});
    await h.framework.runUntilIdle(); assert.equal((await pending).isError, true);
    assert.deepEqual(h.lifecycle, []); assert.equal(h.emitter.openCount, 0);
    assert.equal((h.emitter as unknown as { calls: Map<string, unknown> }).calls.size, 0);
    assert.equal((h.framework as unknown as { scriptToolWaiters: Map<string, unknown> }).scriptToolWaiters.size, 0);
    assert.deepEqual(h.effects, []);
  } finally { await h.close(); }
});

for (const name of ['skip_reply', 'think'] as const) {
  test(`mixed refused call and allowed ${name} preserve independent results and prose`, async () => {
    const h = await harness({ allowedTools: [name], sameRoundThinkTextPolicy: 'private' });
    try {
      const routed = captureRouting(h.framework);
      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Round prose' },
        { type: 'tool_use', id: 'denied', name: generic.name, input: {} },
        { type: 'tool_use', id: 'allowed', name, input: { reason: 'test' } }], 'tool_use'));
      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Trailing prose' }]));
      h.framework.pushEvent({ type: 'external-message', source: 'probe', content: 'Run', metadata: {} }); await h.framework.runUntilIdle();
      const results = h.membrane.lastStream!.receivedToolResults[0] as Array<{ toolUseId: string; isError?: boolean }>;
      assert.equal(results.length, 2); assert.equal(results.find(r => r.toolUseId === 'denied')!.isError, true);
      assert.ok(!results.find(r => r.toolUseId === 'allowed')!.isError); assert.deepEqual(h.effects, []);
      assert.deepEqual(routed, name === 'skip_reply' ? [] : ['Trailing prose']);
    } finally { await h.close(); }
  });
}

for (const permitted of [false, true]) {
  test(`explicit prose primer and bounce advertise help only when permitted: ${permitted}`, async () => {
    const h = await harness({ allowedTools: permitted ? ['prose_help'] : [], proseRouting: 'explicit' });
    try {
      const agent = h.framework.getAgent('assistant')!;
      const internal = h.framework as unknown as {
        maybePrimeProseMode(value: typeof agent): void;
        routingOf(name: string): unknown;
        bounceProse(value: typeof agent, text: string, reason: string, candidates: undefined, prefix: '>>', round: { routing: unknown; notice: 'later' }): void;
      };
      internal.maybePrimeProseMode(agent);
      internal.bounceProse(agent, 'Unrouted prose', 'no destination', undefined, '>>', { routing: internal.routingOf('assistant'), notice: 'later' });
      const compiled = await agent.compileContext(); const text = JSON.stringify(compiled.messages);
      assert.equal(text.includes('The prose_help tool shows the full syntax.'), permitted);
      assert.ok(text.includes('destination prefix') && text.includes('To deliver it unchanged'));
    } finally { await h.close(); }
  });
}

for (const permitted of [false, true]) {
  test(`think's and journal's descriptions point at skip_reply only where the list permits it: ${permitted}`, async () => {
    const h = await harness({ allowedTools: permitted ? ['think', 'journal', 'skip_reply'] : ['think', 'journal'] });
    const slot = h.framework as unknown as { channelRegistry: unknown };
    const original = slot.channelRegistry;
    try {
      // A host with channel servers has the registry, whose think and journal these are.
      const registry = new ChannelRegistry({} as never, {} as never, () => {}, () => {}, {});
      slot.channelRegistry = registry;
      const surface = h.internal.getToolsForAgent('assistant');
      for (const name of ['think', 'journal']) {
        const tool = surface.find((t) => t.name === name);
        assert.ok(tool, `${name} is on the surface`);
        assert.equal(tool.description.includes('skip_reply'), permitted, `${name}'s description names skip_reply only where the agent may call it`);
      }
      // The result's handler can't see the caller's list, so it names no tool to end the turn with.
      const result = await registry.handleChannelToolCall('think', { content: 'working it out' });
      assert.equal(result.success, true);
      assert.ok(!JSON.stringify(result.data).includes('skip_reply'), `think's result names no skip_reply: ${JSON.stringify(result.data)}`);
    } finally { slot.channelRegistry = original; await h.close(); }
  });
}

test('a script in flight cannot gain legacy permissions when its ephemeral run disposes: it ends with its agent', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const h = await harness({ allowedTools: [] }, async call => {
    if ((call.input as {phase: string}).phase === 'barrier') { enter(); await released; }
    return { success: true, data: 'released' };
  });
  let streamEntered!: () => void;
  const streamCreated = new Promise<void>(resolve => { streamEntered = resolve; });
  const originalStream = h.membrane.streamYielding.bind(h.membrane);
  h.membrane.streamYielding = (...args: Parameters<typeof originalStream>) => {
    const stream = originalStream(...args);
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = async function* () {
      await entered;
      const iterator = iterate();
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    };
    streamEntered(); return stream;
  };
  try {
    const created = await h.framework.createEphemeralAgent({ name: 'retiring-worker', model: 'test', systemPrompt: 'Test', allowedTools: ['code_execution', 'probe--allowed'] });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'Complete once.' }]);
    h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Completed' }]));
    const run = h.framework.runEphemeralToCompletion(created.agent, created.contextManager);
    h.framework.start(); await streamCreated;
    const processing = setInterval(() => { void h.framework.runUntilIdle(); }, 10);
    try {
      const script = h.framework.executeToolCall({ id: 'in-flight', name: 'code_execution', callerAgentName: created.agent.name, input: { code: [
        'await tools["probe--allowed"]({ phase: "barrier" });',
        'try { text(JSON.stringify(await tools["probe--allowed"]({ phase: "late" }))); } catch (error) { text(error.message); }',
      ].join('\n'), yield_time_ms: 600_000 } });
      await entered;
      assert.equal(h.framework.getAgent(created.agent.name), created.agent);
      await run;
      assert.equal(h.framework.getAgent(created.agent.name), null);
      // The agent's turn, its last, ended its script, so the late call is never made.
      const result = await script;
      assert.equal(result.isError, true, 'a script stopped at its limit is an error');
      assert.match(result.error ?? '', /^Script s\d+-[0-9a-z]{4} was stopped: its agent's turn ended, and only the primary agent's scripts outlive a turn\./);
      assert.match(result.error ?? '', /still running when the script ended, so it may or may not take effect: tools\["probe--allowed"\]\(\{"phase":"barrier"\}\)/);
      release();
      // And a call a child sent for it anyway is refused: the agent has gone.
      const late = await scriptCall(h.framework, created.agent.name, 'probe--allowed', { phase: 'late' });
      assert.equal(late.refused, true);
      assert.match(late.refused ? late.message : '', /not a running agent.*only while registered/);
      // The refusal came before any dispatch, so nothing more can land.
      assert.deepEqual(h.effects.map(call => call.input), [{phase: 'barrier'}]);
      // The released barrier call closes once its handler returns, leaving nothing open.
      const waiters = (h.framework as unknown as { scriptToolWaiters: Map<string, unknown> }).scriptToolWaiters;
      for (let i = 0; i < 2_000 && (h.emitter.openCount !== 0 || waiters.size !== 0); i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(h.emitter.openCount, 0);
      assert.equal(waiters.size, 0);
    } finally { clearInterval(processing); }
  } finally { release(); await h.close(); }
});

test('disposed conversation fork cannot regain legacy tool permissions', async () => {
  const h = await harness({ allowedTools: ['probe--allowed'] });
  try {
    const internals = h.framework as unknown as {
      createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<{name: string}>;
      disposeConversationAgent(name: string): void;
    };
    const fork = await internals.createConversationAgent('conversation-probe-g1', { serverId: 'stub', channelId: 'world:probe' });
    assert.ok(h.framework.getAgent(fork.name));
    const call = {id: 'fork-permitted', name: 'probe--allowed', input: {}, callerAgentName: fork.name};
    assert.equal((await h.framework.executeToolCall(call)).success, true);
    internals.disposeConversationAgent(fork.name);
    assert.equal(h.framework.getAgent(fork.name), null);
    const before = h.effects.length;
    assert.equal((await h.framework.executeToolCall({...call,id:'fork-late'})).success, false);
    assert.equal(h.effects.length, before);
    assert.equal(h.emitter.openCount, 0);
  } finally { await h.close(); }
});

test('module utilities are callable tools out of the tool list, and utils is gone', async () => {
  const h = await harness({ allowedTools: 'all' });
  try {
    const framework = h.framework as typeof h.framework & {getAllUtilities(): ReturnType<typeof h.framework.getAllTools>};
    const utilities = framework.getAllUtilities();
    assert.deepEqual(utilities.map(tool => tool.name), ['probe--allowed_util', 'probe--denied_util']);
    assert.ok(!h.framework.getAllTools().some(tool => tool.name === 'utils'));
    assert.ok(h.framework.getAllTools().some(tool => tool.name === 'probe--allowed_util'), 'callable by name');
    const surface = (await h.framework.previewActivation('assistant')).tools ?? [];
    assert.ok(!surface.some(tool => tool.name === 'probe--allowed_util' || tool.name === 'utils'), 'neither in the tool list');
  } finally { await h.close(); }
});

test('an agent that may not call the meta-tools keeps every tool it may call in its list, a utility aside', async () => {
  const h = await harness({ allowedTools: ['probe--allowed', 'probe--allowed_util', 'agent_settings'] });
  try {
    const surface = ((await h.framework.previewActivation('assistant')).tools ?? []).map(tool => tool.name);
    assert.ok(surface.includes('probe--allowed') && surface.includes('agent_settings'), 'its tools, built-in ones included, stay');
    assert.ok(!surface.includes('probe--allowed_util'), 'a utility is never a tool-list tool; it can still be called by name');
    const called = await h.framework.executeToolCall({ id: 'by-name', name: 'probe--allowed_util', input: {}, callerAgentName: 'assistant' });
    assert.equal(called.success, true, called.error);
  } finally { await h.close(); }
});

for (const route of ['model', 'public', 'script'] as const) {
  test(`named utility grant alone executes on ${route}`, async () => {
    const h = await harness({ allowedTools: ['probe--allowed_util'] });
    const call = { id: 'direct-utility', name: 'probe--allowed_util', input: {}, callerAgentName: 'assistant' };
    try {
      if (route === 'model') {
        const [result] = await h.turn([call]); assert.ok(!result.isError);
      } else {
        const pending = route === 'public' ? h.framework.executeToolCall(call) : h.internal.dispatchScriptToolCall('assistant', call.name, {});
        const processing = setInterval(() => { void h.framework.runUntilIdle(); }, 5);
        try { assert.equal((await pending).success, true); }
        finally { clearInterval(processing); }
      }
      assert.deepEqual(h.effects.map(effect => effect.name), ['allowed_util']);
    } finally { await h.close(); }
  });
}

test('never-run and retired ephemerals report missing registration, not allowlist advice', async () => {
  const h = await harness({ allowedTools: 'all' });
  try {
    const created = await h.framework.createEphemeralAgent({ name: 'identity-worker', model: 'test', systemPrompt: 'Test', allowedTools: ['toolsets--open', 'toolsets--act', 'toolsets--look', 'toolsets--close', 'probe--allowed_util'] });
    const check = async () => {
      const before = h.effects.length;
      for (const [name, input] of [['probe--allowed_util', {}], ['toolsets--act', { tool: 'probe--allowed_util', args: {} }], ['toolsets--look', {}]] as const) {
        const result = await h.framework.executeToolCall({ id: `unregistered-${name}`, name, input, callerAgentName: created.agent.name });
        assert.equal(result.success, false); assert.equal(result.isError, true);
        assert.match(result.error!, /identity-worker.*not a running agent.*only while registered, so the call didn't run\.$/);
        assert.ok(!result.error!.includes('allowedTools'), 'identity failure must not give allowlist advice');
      }
      assert.equal(h.effects.length, before); assert.deepEqual(h.lifecycle, []); assert.equal(h.emitter.openCount, 0);
    };
    await check();
    created.contextManager.addMessage('user', [{ type: 'text', text: 'Complete.' }]);
    h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Completed' }]));
    const run = h.framework.runEphemeralToCompletion(created.agent, created.contextManager);
    await h.framework.runUntilIdle(); await run;
    assert.equal(h.framework.getAgent(created.agent.name), null);
    await check(); created.cleanup();
  } finally { await h.close(); }
});

test('a call denied at dispatch is refused, so a script is told it never ran', async () => {
  const h = await harness({ denyToolsAtDispatch: ['probe--denied'] });
  try {
    const pending = scriptCall(h.framework, 'assistant', 'probe--denied', {});
    await h.framework.runUntilIdle();
    const answer = await pending;
    assert.equal(answer.refused, true);
    assert.match(answer.refused ? answer.message : '', /probe--denied is not available to assistant/);
    assert.equal(h.effects.length, 0);
  } finally { await h.close(); }
});

test("a resident's call of its reader's tool is refused, so a script is told it never ran", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-allowed-tools-reader-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'scout', model: 'test', systemPrompt: 'Test' }],
    modules: [], syncIntervalMs: 0, codeExecution: { enabled: true },
    subconscious: { enabled: true, reader: 'forks', model: 'test', voice: 'Read for scout.' },
  });
  try {
    const pending = scriptCall(framework, 'scout', 'deliver_summary', { text: 'me?', channelId: 'somewhere' });
    await framework.runUntilIdle();
    const answer = await pending;
    assert.equal(answer.refused, true);
    assert.match(answer.refused ? answer.message : '', /available to the resident's reader, not to scout/);
  } finally { await framework.stop(); rmSync(dir, { recursive: true, force: true }); }
});

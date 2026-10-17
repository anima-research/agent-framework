import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/framework.js';
import type { AgentConfig, Module, ModuleContext, ToolCall, ToolResult } from '../src/types/index.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { ToolLifecycleEmitter, type ToolLifecycleParams } from '../src/mcpl/tool-lifecycle.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

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

test('model-issued Python cannot forge unlisted inner generic or builtin calls', async () => {
  const h = await harness({ allowedTools: ['code_execution', 'probe--allowed'] });
  try {
    const before = h.framework.getAgentRuntimeSettings('assistant');
    const [result] = await h.turn([{
      id: 'script', name: 'code_execution', input: { code: [
        'make = probe__allowed.__globals__["_make_tool_fn"]',
        'for name, args in [("probe--denied", {}), ("agent_settings", {"action": "update", "same_round_think_text_policy": "private"})]:',
        '    try:',
        '        print(await make(name, "forged")(args))',
        '    except Exception as error:',
        '        print(str(error))',
        'print(await probe__allowed())',
      ].join('\n') },
    }]);
    assert.equal(result.toolUseId, 'script');
    assert.ok(!result.isError);
    const execution = JSON.parse(result.content) as { stdout: string; stderr: string; return_code: number };
    assert.equal(execution.return_code, 0, execution.stderr);
    assert.equal((execution.stdout.match(/not permitted.*allowedTools/g) ?? []).length, 2);
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
      input: { code: 'print(await probe__denied())' },
    });
    // The Python subprocess enqueues its inner call after startup.
    const processing = setInterval(() => { void h.framework.runUntilIdle(); }, 10);
    try {
      const result = await pending;
      assert.equal(result.success, true);
      assert.equal((result.data as { return_code: number }).return_code, 0);
      assert.equal(h.effects.length, 1);
    } finally { clearInterval(processing); }
  } finally { await h.close(); }
});

for (const call of [generic, { id: 'public-script', name: 'code_execution', input: { code: 'print("forbidden")' } }]) {
  test(`registered public dispatch refuses ${call.name} before effects`, async () => {
    const h = await harness({ allowedTools: [] });
    try {
      const result = await h.framework.executeToolCall({ ...call, callerAgentName: 'assistant' });
      assert.equal(result.success, false);
      assert.equal(result.isError, true);
      assert.match(result.error!, /not permitted.*allowedTools/);
      assert.equal(h.effects.length, 0);
      assert.deepEqual(h.lifecycle, []);
      assert.equal(h.traces.filter((e) => e.callId === call.id && e.type === 'tool:failed').length, 1);
      // A refused code_execution must not even create an interpreter.
      assert.equal((h.framework as unknown as { codeExecutionRunners: Map<string, unknown> }).codeExecutionRunners.size, 0);
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
    routeSpeech: async (_agent: string, text: string) => { routed.push(text); return { delivered: true, channelId: 'world:commons' }; },
    resolveLocus: () => 'world:commons', getDefaultPublishChannel: () => null,
    isChannelOpen: () => true, getDescriptor: () => undefined, getChannelTools: () => [],
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(registry, {
    get: (target, prop: string) => prop in target ? target[prop] : () => undefined,
  });
  return routed;
}

for (const fallback of [false, true]) {
  for (const name of ['skip_reply', 'think', 'channel_publish']) {
    for (const permitted of [false, true]) {
      test(`${fallback ? 'fallback' : 'native'} prose disposition ${permitted ? 'honors permitted' : 'ignores denied'} ${name}`, async () => {
        const h = await harness({ allowedTools: permitted ? [name] : [], sameRoundThinkTextPolicy: 'private' });
        try {
          const routed = captureRouting(h.framework);
          const call = { type: 'tool_use' as const, id: 'disposition', name, input: { reason: 'test', content: 'test' } };
          if (fallback) {
            const streamYielding = h.membrane.streamYielding.bind(h.membrane);
            h.membrane.streamYielding = (request, options) => {
              const stream = streamYielding(request, options);
              const iterate = stream[Symbol.asyncIterator].bind(stream);
              stream[Symbol.asyncIterator] = async function* () {
                for await (const event of { [Symbol.asyncIterator]: iterate }) {
                  if (event.type === 'tool-calls') {
                    yield { ...event, context: { ...event.context, roundContent: undefined } };
                  } else if (event.type === 'complete') {
                    // Older membrane completion contains the cumulative tool round.
                    yield { ...event, response: { ...event.response, content: [call, ...event.response.content] } };
                  } else yield event;
                }
              };
              return stream;
            };
          }
          h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public round prose' }, call], 'tool_use'));
          h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Public trailing prose' }]));
          h.framework.pushEvent({ type: 'external-message', source: 'probe', content: 'Run probe', metadata: {} });
          await h.framework.runUntilIdle();
          const results = h.membrane.lastStream!.receivedToolResults[0] as Array<{ isError?: boolean; content: string }>;
          if (!permitted) {
            assert.equal(results[0].isError, true);
            assert.match(results[0].content, /not permitted.*allowedTools/);
            assert.ok(routed.includes('Public trailing prose'), 'denied tools cannot silence trailing public prose');
            if (!fallback) assert.ok(routed.includes('Public round prose'), 'denied think cannot privatize same-round public prose');
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

for (const route of ['model', 'public', 'script'] as const) {
  test(`utility run checks the utility name on the ${route} route`, async () => {
    const h = await harness({ allowedTools: ['utils', 'probe--allowed_util'] });
    const input = { action: 'run', name: 'probe--denied_util', args: {} };
    try {
      if (route === 'model') {
        const [result] = await h.turn([{ id: 'utility-denied', name: 'utils', input }]);
        assert.equal(result.isError, true); assert.match(result.content, /not permitted.*allowedTools/);
        const terminals = h.traces.filter(event => event.callId === 'utility-denied' &&
          ['tool:failed', 'tool:completed'].includes(event.type as string));
        assert.deepEqual(terminals.map(event => event.tool), ['utils']);
        assert.deepEqual(h.lifecycle.map(event => [event.tool, event.phase]), [['utils', 'started'], ['utils', 'completed']]);
        assert.equal(h.emitter.openCount, 0);
        assert.equal((h.emitter as unknown as { calls: Map<string, unknown> }).calls.size, 0);
        assert.equal((h.framework as unknown as { scriptToolWaiters: Map<string, unknown> }).scriptToolWaiters.size, 0);
      } else if (route === 'public') {
        const result = await h.framework.executeToolCall({ id: 'utility-denied', name: 'utils', input, callerAgentName: 'assistant' });
        assert.equal(result.isError, true); assert.match(result.error!, /not permitted.*allowedTools/);
      } else {
        const pending = h.internal.dispatchScriptToolCall('assistant', 'utils', input);
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

for (const allowedTools of [['utils', 'probe--allowed_util'], 'all'] as AgentConfig['allowedTools'][]) {
  test(`utility list and describe expose only executable names: ${JSON.stringify(allowedTools)}`, async () => {
    const h = await harness({ allowedTools });
    const call = (input: unknown) => h.framework.executeToolCall({ id: 'utility', name: 'utils', input, callerAgentName: 'assistant' });
    try {
      const listed = await call({ action: 'list' }); assert.equal(listed.success, true);
      const expected = allowedTools === 'all' ? ['probe--allowed_util', 'probe--denied_util'] : (allowedTools as string[]).filter(n => n !== 'utils');
      assert.deepEqual((listed.data as Array<{ name: string }>).map(v => v.name), expected);
      const described = await call({ action: 'describe', name: 'probe--denied_util' });
      assert.equal(described.success, allowedTools === 'all');
      if (allowedTools !== 'all') assert.ok(!JSON.stringify(described).includes('Inert utility counter'));
      for (const name of expected) assert.equal((await call({ action: 'run', name, args: {} })).success, true);
      assert.deepEqual(h.effects.map(c => 'probe--' + c.name), expected);
    } finally { await h.close(); }
  });
}

test('trusted module utility call retains its authority with a restricted caller name', async () => {
  const h = await harness({ allowedTools: [] });
  try {
    const result = await h.moduleCall({ id: 'trusted-utility', name: 'utils', input: { action: 'run', name: 'probe--denied_util', args: {} }, callerAgentName: 'assistant' });
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
      const internal = h.framework as unknown as { maybePrimeProseMode(value: typeof agent): void; bounceProse(value: typeof agent, text: string, reason: string): void };
      internal.maybePrimeProseMode(agent); internal.bounceProse(agent, 'Unrouted prose', 'no destination');
      const compiled = await agent.compileContext(); const text = JSON.stringify(compiled.messages);
      assert.equal(text.includes('The prose_help tool shows the full syntax.'), permitted);
      assert.ok(text.includes('destination prefix') && text.includes('To deliver it unchanged'));
    } finally { await h.close(); }
  });
}

test('script in flight cannot gain legacy permissions when its ephemeral run disposes', async () => {
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
    const script = h.framework.executeToolCall({ id: 'in-flight', name: 'code_execution', callerAgentName: created.agent.name, input: { code: [
      'await probe__allowed({"phase": "barrier"})',
      'try:', '    print(await probe__allowed({"phase": "late"}))',
      'except Exception as error:', '    print(str(error))',
    ].join('\n') } });
    await entered;
    assert.equal(h.framework.getAgent(created.agent.name), created.agent);
    await run;
    assert.equal(h.framework.getAgent(created.agent.name), null);
    release();
    const result = await script; assert.equal(result.success, true);
    assert.match((result.data as { stdout: string }).stdout, /not a running agent.*only while registered/);
    assert.deepEqual(h.effects.map(call => call.input), [{phase: 'barrier'}]);
    assert.equal(h.emitter.openCount, 0);
    assert.equal((h.framework as unknown as { scriptToolWaiters: Map<string, unknown> }).scriptToolWaiters.size, 0);
  } finally { release(); await h.close(); }
});

test('disposed conversation fork cannot regain legacy tool permissions', async () => {
  const h = await harness({ allowedTools: ['probe--allowed'] });
  try {
    const internals = h.framework as unknown as {
      createConversationAgent(name: string, channel: string): Promise<{name: string}>;
      disposeConversationAgent(name: string): void;
    };
    const fork = await internals.createConversationAgent('conversation-probe-g1', 'world:probe');
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

test('public utility catalogue preserves names and the collapsed model surface', async () => {
  const h = await harness({ allowedTools: 'all' });
  try {
    const framework = h.framework as typeof h.framework & {getAllUtilities(): ReturnType<typeof h.framework.getAllTools>};
    const utilities = framework.getAllUtilities();
    assert.deepEqual(utilities.map(tool => tool.name), ['probe--allowed_util', 'probe--denied_util']);
    assert.ok(h.framework.getAllTools().some(tool => tool.name === 'utils'));
    assert.ok(!h.framework.getAllTools().some(tool => tool.name === 'probe--allowed_util'));
    utilities.pop();
    assert.equal(framework.getAllUtilities().length, 2);
  } finally { await h.close(); }
});


for (const allowedTools of [['utils'], ['utils', 'probe--allowed']]) {
  test(`empty permitted utility surface reports migration once: ${JSON.stringify(allowedTools)}`, async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args) => {
      const line = args.join(' ');
      if (!line.startsWith('[deprecated]')) warnings.push(line);
    };
    const h = await harness({ allowedTools });
    try {
      assert.equal(warnings.length, 1, 'resident warns after initial modules register');
      assert.match(warnings[0], /assistant.*2 registered.*none permitted.*allowedTools.*module--utility/);
      assert.ok(h.framework.getAllTools().some(tool => tool.name === 'utils'), 'global catalogue is unchanged');
      for (let i = 0; i < 2; i++) {
        assert.ok(!h.internal.getToolsForAgent('assistant').some(tool => tool.name === 'utils'));
        assert.ok(!(await h.framework.previewActivation('assistant')).tools?.some(tool => tool.name === 'utils'));
      }
      const call = (input: unknown) => h.framework.executeToolCall({ id: 'empty-utilities', name: 'utils', input, callerAgentName: 'assistant' });
      const listed = await call({ action: 'list' });
      assert.equal(listed.success, false); assert.equal(listed.isError, true);
      assert.match(listed.error!, /2 registered.*0 permitted.*none permitted.*allowedTools.*module--utility/);
      assert.equal(listed.data, undefined, 'empty permission diagnostic uses existing failure shape');
      const unknown = await call({ action: 'describe', name: 'missing' });
      assert.equal(unknown.isError, true);
      assert.match(unknown.error!, /2 registered.*0 permitted.*none permitted.*allowedTools/);
      assert.ok(!JSON.stringify(unknown).includes('probe--denied_util'), 'unknown diagnostics reveal no denied names');
      assert.ok(!JSON.stringify(unknown).includes('Inert utility counter'));
      assert.equal(warnings.length, 1, 'repeat surfaces do not repeat the warning');
      assert.deepEqual(h.effects, []);
    } finally { await h.close(); console.warn = warn; }
  });
}

test('zero-module snapshots do not consume the later utility migration warning', async () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args) => {
      const line = args.join(' ');
      if (!line.startsWith('[deprecated]')) warnings.push(line);
    };
  const h = await harness({ allowedTools: ['utils'] }, undefined, true);
  try {
    assert.ok(!h.internal.getToolsForAgent('assistant').some(tool => tool.name === 'utils'));
    assert.deepEqual(warnings, []);
    const empty = await h.framework.executeToolCall({ id: 'no-utilities', name: 'utils', input: { action: 'list' }, callerAgentName: 'assistant' });
    assert.equal(empty.success, true); assert.deepEqual(empty.data, []);
    await h.framework.addModule(h.module);
    assert.ok(!h.internal.getToolsForAgent('assistant').some(tool => tool.name === 'utils'));
    h.internal.getToolsForAgent('assistant');
    assert.equal(warnings.length, 1); assert.match(warnings[0], /assistant.*2 registered/);
  } finally { await h.close(); console.warn = warn; }
});

for (const allowedTools of [['utils', 'probe--allowed_util'], ['probe--allowed_util'], 'all'] as AgentConfig['allowedTools'][]) {
  test(`permitted utilities retain surface without migration warnings: ${JSON.stringify(allowedTools)}`, async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args) => {
      const line = args.join(' ');
      if (!line.startsWith('[deprecated]')) warnings.push(line);
    };
    const h = await harness({ allowedTools });
    try {
      const surface = (await h.framework.previewActivation('assistant')).tools ?? [];
      assert.equal(surface.some(tool => tool.name === 'utils'), allowedTools === 'all' || allowedTools!.includes('utils'));
      assert.deepEqual(warnings, []);
    } finally { await h.close(); console.warn = warn; }
  });
}

for (const route of ['model', 'public', 'script'] as const) {
  test(`denied utility describe matches run refusal on ${route}`, async () => {
    const h = await harness({ allowedTools: ['utils', 'probe--allowed_util'] });
    try {
      const errors: string[] = [];
      for (const action of ['describe', 'run']) {
        const input = { action, name: 'probe--denied_util', args: {} };
        const id = `denied-${action}`;
        if (route === 'model') {
          const [result] = await h.turn([{ id, name: 'utils', input }]);
          assert.equal(result.isError, true); errors.push(result.content);
          const terminals = h.traces.filter(event => event.callId === id && ['tool:failed', 'tool:completed'].includes(event.type as string));
          assert.deepEqual(terminals.map(event => event.tool), ['utils']);
        } else {
          const pending = route === 'public'
            ? h.framework.executeToolCall({ id, name: 'utils', input, callerAgentName: 'assistant' })
            : h.internal.dispatchScriptToolCall('assistant', 'utils', input);
          const processing = setInterval(() => { void h.framework.runUntilIdle(); }, 5);
          try {
            const result = await pending;
            assert.equal(result.isError, true); errors.push(result.error!);
          } finally { clearInterval(processing); }
        }
      }
      assert.equal(errors[0], errors[1]);
      assert.match(errors[0], /not permitted.*allowedTools/);
      assert.ok(!errors[0].includes('Inert utility counter'));
      assert.equal(h.emitter.openCount, 0); assert.deepEqual(h.effects, []);
      const unknown = await h.framework.executeToolCall({ id: 'unknown', name: 'utils', input: { action: 'describe', name: 'missing' }, callerAgentName: 'assistant' });
      assert.match(unknown.error!, /2 registered.*1 permitted/);
      assert.ok(!unknown.error!.includes('probe--denied_util'));
    } finally { await h.close(); }
  });

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

test('never-run and retired ephemerals report missing registration before utility migration advice', async () => {
  const h = await harness({ allowedTools: 'all' });
  try {
    const created = await h.framework.createEphemeralAgent({ name: 'identity-worker', model: 'test', systemPrompt: 'Test', allowedTools: ['utils', 'probe--allowed_util'] });
    const check = async () => {
      const before = h.effects.length;
      for (const [name, input] of [['probe--allowed_util', {}], ['utils', { action: 'list' }], ['utils', { action: 'describe', name: 'missing' }]] as const) {
        const result = await h.framework.executeToolCall({ id: `unregistered-${name}`, name, input, callerAgentName: created.agent.name });
        assert.equal(result.success, false); assert.equal(result.isError, true);
        assert.match(result.error!, /identity-worker.*not a running agent.*only while registered/);
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

test('ephemeral and conversation fork first surfaces warn once per Agent instance', async () => {
  const h = await harness({ allowedTools: ['utils'] });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args) => {
      const line = args.join(' ');
      if (!line.startsWith('[deprecated]')) warnings.push(line);
    };
  try {
    const internals = h.framework as unknown as { createConversationAgent(name: string, channel: string): Promise<{name: string}>; disposeConversationAgent(name: string): void };
    const fork = await internals.createConversationAgent('utility-fork-g1', 'world:probe');
    const created = await h.framework.createEphemeralAgent({ name: 'utility-worker', model: 'test', systemPrompt: 'Test', allowedTools: ['utils'] });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'Complete.' }]);
    h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Completed' }]));
    const run = h.framework.runEphemeralToCompletion(created.agent, created.contextManager);
    for (const name of [fork.name, created.agent.name]) {
      assert.ok(!h.internal.getToolsForAgent(name).some(tool => tool.name === 'utils'));
      h.internal.getToolsForAgent(name);
      assert.equal(warnings.filter(line => line.includes(name)).length, 1);
    }
    await h.framework.runUntilIdle(); await run;
    assert.equal(warnings.length, 2);
    internals.disposeConversationAgent(fork.name); created.cleanup();
  } finally { await h.close(); console.warn = warn; }
});

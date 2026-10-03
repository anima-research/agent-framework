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

async function harness(config: Partial<AgentConfig>) {
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
    async handleToolCall(call) {
      effects.push(call);
      return { success: true, data: 'executed' };
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
    modules: [module], syncIntervalMs: 0, codeExecution: { enabled: true },
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
    dispatchScriptToolCall(agent: string, tool: string, input: Record<string, unknown>): Promise<ToolResult>;
  };
  internal.toolLifecycleEmitter = emitter;
  return {
    framework, membrane, effects, traces, lifecycle, emitter, internal,
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

test('explicit prose helper remains advertised and executable with an empty list', async () => {
  const h = await harness({ allowedTools: [], proseRouting: 'explicit' });
  try {
    assert.ok(h.framework.listToolClasses('assistant').some((t) => t.tool === 'prose_help'));
    const [result] = await h.turn([{ id: 'help', name: 'prose_help', input: {} }]);
    assert.equal(result.toolUseId, 'help');
    assert.ok(!result.isError);
    assert.match(result.content, />>/);
  } finally { await h.close(); }
});

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

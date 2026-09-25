import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassthroughStrategy, type StoredMessage, type StrategyContext } from '@animalabs/context-manager';
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse, YieldingStreamOptions } from '@animalabs/membrane';
import { Membrane as RealMembrane, NativeFormatter, type ProviderAdapter, type ProviderRequest,
  type ProviderResponse, type StreamCallbacks } from '@animalabs/membrane';
import { AgentFramework, type AgentConfig, type AgentSettingsExtension, type Module, type ModuleContext,
  type ToolCall, type ToolResult, type ProcessEvent, type ProcessState } from '../src/index.js';
import { TOOL_RESULT_GUARD_AUDIT_STATE, TOOL_RESULT_GUARD_NOTICE } from '../src/tool-result-guard.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const answer = () => createMockResponse([{ type: 'text', text: 'continued' }]);
const refused = () => ({
  ...createMockResponse([{ type: 'text', text: 'discard-this-partial-output' }], 'refusal'),
  raw: { request: {}, response: { stop_details: { category: 'test-category' } } },
}) as NormalizedResponse;
const calls = (...ids: string[]) => createMockResponse(ids.map((id) => ({
  type: 'tool_use', id, name: 'test--read', input: {},
})), 'tool_use');

class ScriptMembrane {
  requests: NormalizedRequest[] = [];
  streams: MockYieldingStream[] = [];
  retriesAtSubmission: number[] = [];
  onSubmit?: () => void;
  constructor(readonly scripts: NormalizedResponse[][]) {}
  streamYielding(request: NormalizedRequest, options: YieldingStreamOptions = {}) {
    this.requests.push(structuredClone({ ...request, onCacheWireReceipt: undefined }));
    const script = this.scripts.shift();
    assert.ok(script, 'unexpected extra inference');
    const stream = new MockYieldingStream(script);
    const provide = stream.provideToolResults.bind(stream);
    stream.provideToolResults = (...args) => {
      this.retriesAtSubmission.push(options.refusalRetries ?? 0);
      this.onSubmit?.();
      provide(...args);
    };
    this.streams.push(stream);
    return stream;
  }
  asMembrane() { return this as unknown as Membrane; }
}

class ReadModule implements Module {
  readonly name = 'test';
  readonly calls: string[] = [];
  readonly speeches: string[] = [];
  constructor(readonly results: Record<string, ToolResult> = {}) {}
  async start(ctx: ModuleContext) { ctx.registerSpeechHandler('*'); }
  async stop() {}
  getTools() { return [{ name: 'read', description: 'Read a result', inputSchema: { type: 'object' as const, properties: {} } }]; }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call.id);
    return this.results[call.id] ?? { success: true, data: `payload-${call.id}` };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState) {
    return event.type === 'external-message'
      ? { addMessages: [{ participant: 'user', content: [{ type: 'text' as const, text: String(event.content) }] }], requestInference: true }
      : {};
  }
  async onAgentSpeech(_name: string, content: ContentBlock[]) {
    this.speeches.push(...content.flatMap((block) => block.type === 'text' ? [block.text] : []));
  }
}

class IngressObserver extends PassthroughStrategy {
  snapshots: string[] = [];
  async onNewMessage(_message: StoredMessage, ctx: StrategyContext) {
    this.snapshots.push(JSON.stringify(ctx.messageStore.getAll()));
  }
}

async function harness(scripts: NormalizedResponse[][], config: Partial<AgentConfig> = {}, results?: Record<string, ToolResult>) {
  const dir = mkdtempSync(join(tmpdir(), 'af-tool-result-guard-')); dirs.push(dir);
  const membrane = new ScriptMembrane(scripts);
  const module = new ReadModule(results);
  const base = { storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system', ...config }], modules: [module], syncIntervalMs: 0 };
  const framework = await AgentFramework.create(base);
  const run = async () => {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'read', metadata: {} });
    await framework.runUntilIdle();
  };
  return { framework, membrane, module, base, run };
}

function extension(framework: AgentFramework): AgentSettingsExtension {
  const extensions = (framework as unknown as {
    collectAgentSettingsExtensions(): Map<string, AgentSettingsExtension>;
  }).collectAgentSettingsExtensions();
  return [...extensions.values()].find((ext) => ext.keys.includes('tool_result_guard'))!;
}

function toolResults(framework: AgentFramework) {
  return framework.getAgent('assistant')!.getContextManager().getAllMessages()
    .flatMap((message) => message.content.filter((block) => block.type === 'tool_result'));
}

test('default off retains existing refusal behavior and original tool output', async () => {
  const h = await harness([[calls('one'), refused()]]);
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 1);
    assert.match(JSON.stringify(toolResults(h.framework)), /payload-one/);
    assert.equal(extension(h.framework).get('assistant').tool_result_guard, false);
  } finally { await h.framework.stop(); }
});

test('withholds the entire latest batch, retries inference once, and keeps originals in Chronicle', async () => {
  const strategy = new IngressObserver();
  const image = Buffer.from('original-image-bytes').toString('base64');
  const h = await harness([[calls('text', 'image', 'error'), refused()], [answer()]],
    { toolResultGuard: true, strategy, refusalHandling: { retries: 3 } }, {
      text: { success: true, data: 'original-text-payload' },
      image: { success: true, data: [{ type: 'image', mimeType: 'image/png', data: image }] },
      error: { success: false, isError: true, error: 'original-error-payload' },
    });
  let stagedSequence = 0;
  let originalStopped = false;
  h.membrane.onSubmit = () => { stagedSequence = h.framework.getStore().currentSequence(); };
  try {
    await h.run();
    assert.deepEqual(h.module.calls.sort(), ['error', 'image', 'text']);
    assert.equal(h.membrane.requests.length, 2);
    assert.deepEqual(h.membrane.retriesAtSubmission, [0], 'first refusal must reach guard before plain retries');
    const retry = h.membrane.requests[1];
    assert.equal(retry.config.model, 'test');
    assert.doesNotMatch(JSON.stringify(retry), /original-text-payload|original-error-payload|discard-this-partial-output|test-category/);
    assert.ok(!JSON.stringify(retry).includes(image));
    assert.equal(retry.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_use').length, 3);
    const guarded = toolResults(h.framework);
    assert.equal(guarded.length, 3);
    assert.ok(guarded.every((block) => block.content === TOOL_RESULT_GUARD_NOTICE));
    assert.equal(guarded.find((b) => b.toolUseId === 'error')?.isError, true);
    assert.deepEqual(h.module.speeches, ['continued']);
    assert.ok(strategy.snapshots.every((s) => !s.includes('original-text-payload') && !s.includes(image)),
      'background strategy ingress must never see withheld payloads');

    const store = h.framework.getStore();
    const audit = store.getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.match(JSON.stringify(audit[0]), /original-text-payload|original-error-payload/);
    assert.ok(JSON.stringify(audit[0]).includes(image));
    assert.equal(audit.at(-1)?.type, 'withheld');
    const historical = store.getStateJsonAt(TOOL_RESULT_GUARD_AUDIT_STATE, stagedSequence) as unknown[];
    assert.deepEqual(audit[0], historical[0], 'redaction only appends; original Chronicle record is unchanged');
    const original = structuredClone(audit[0]);
    extension(h.framework).update('assistant', { tool_result_guard: false });
    assert.ok(toolResults(h.framework).every((block) => block.content === TOOL_RESULT_GUARD_NOTICE));
    await h.framework.stop();
    originalStopped = true;
    const restarted = await AgentFramework.create(h.base);
    try {
      assert.equal(extension(restarted).get('assistant').tool_result_guard, false, 'explicit disable persists');
      assert.ok(toolResults(restarted).every((block) => block.content === TOOL_RESULT_GUARD_NOTICE));
      assert.deepEqual((restarted.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as unknown[])[0], original);
      const preview = await restarted.previewActivation('assistant');
      assert.doesNotMatch(JSON.stringify(preview), /original-text-payload|original-error-payload/);
    } finally { await restarted.stop(); }
  } finally { if (!originalStopped) await h.framework.stop(); }
});

test('successful physical rounds admit results; refusal affects only the newest batch', async () => {
  const h = await harness([[calls('accepted'), calls('withheld'), refused()], [answer()]], { toolResultGuard: true });
  try {
    await h.run();
    const results = toolResults(h.framework);
    assert.match(String(results.find((b) => b.toolUseId === 'accepted')?.content), /payload-accepted/);
    assert.equal(results.find((b) => b.toolUseId === 'withheld')?.content, TOOL_RESULT_GUARD_NOTICE);
    assert.deepEqual(h.module.calls, ['accepted', 'withheld']);
    assert.equal(h.framework.getAgent('assistant')!.toolResultGuard.enabled, true);
  } finally { await h.framework.stop(); }
});

test('a second refusal stops recovery without auto-rewinding older or human messages', async () => {
  const h = await harness([[calls('one'), refused()], [refused()]],
    { toolResultGuard: true, refusalHandling: { autoRewind: true, retries: 3 } });
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 2);
    assert.deepEqual(h.module.calls, ['one']);
    assert.deepEqual(h.module.speeches, []);
    const messages = h.framework.getAgent('assistant')!.getContextManager().getAllMessages();
    assert.ok(messages.some((m) => m.content.some((b) => b.type === 'text' && b.text === 'read')));
    assert.doesNotMatch(JSON.stringify(messages), /discard-this-partial-output|refusal-rewind/);
    assert.equal(toolResults(h.framework)[0].content, TOOL_RESULT_GUARD_NOTICE);
  } finally { await h.framework.stop(); }
});

test('durable typed agent setting can be enabled, disabled, and explicitly reset', async () => {
  const h = await harness([]);
  let originalStopped = false;
  try {
    const ext = extension(h.framework);
    for (const value of ['true', 1, null, {}]) {
      assert.throws(() => ext.update('assistant', { tool_result_guard: value }), /must be a boolean/);
    }
    ext.update('assistant', { tool_result_guard: true });
    assert.equal(ext.get('assistant').tool_result_guard, true);
    await h.framework.stop();
    originalStopped = true;
    const restarted = await AgentFramework.create(h.base);
    try {
      const restored = extension(restarted);
      assert.equal(restored.get('assistant').tool_result_guard, true);
      assert.equal(restored.get('assistant').tool_result_guard_source, 'runtime_override');
      restored.reset!('assistant');
      assert.equal(restored.get('assistant').tool_result_guard, false);
      const tool = restarted.getAllTools().find((t) => t.name === 'agent_settings')!;
      assert.equal((tool.inputSchema.properties as Record<string, { type: string }>).tool_result_guard.type, 'boolean');
      assert.doesNotMatch(JSON.stringify(tool), /classifier/i);
    } finally { await restarted.stop(); }
  } finally { if (!originalStopped) await h.framework.stop(); }
});

test('a normal successful response releases the pending output into versioned history', async () => {
  const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 1);
    assert.match(String(toolResults(h.framework)[0].content), /payload-one/);
    const records = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.equal(records.at(-1)?.type, 'accepted');
    assert.equal(h.framework.getAgent('assistant')!.toolResultGuard.enabled, true);
  } finally { await h.framework.stop(); }
});

test('refusal without a new tool result does not invoke tool guard recovery', async () => {
  const h = await harness([[refused()]], { toolResultGuard: true });
  try { await h.run(); assert.equal(h.membrane.requests.length, 1); }
  finally { await h.framework.stop(); }
});

test('budget restart submits staged originals, then recovers without re-executing tools', async () => {
  const h = await harness([[calls('one')], [refused()], [answer()]], { toolResultGuard: true, maxStreamTokens: 1 });
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 3);
    assert.match(JSON.stringify(h.membrane.requests[1]), /payload-one/);
    assert.doesNotMatch(JSON.stringify(h.membrane.requests[2]), /payload-one/);
    assert.deepEqual(h.module.calls, ['one']);
    assert.equal(toolResults(h.framework)[0].content, TOOL_RESULT_GUARD_NOTICE);
  } finally { await h.framework.stop(); }
});

test('ephemeral run settles only after recovery and counts each tool once', async () => {
  const h = await harness([[calls('one'), refused()], [answer()]]);
  try {
    const created = await h.framework.createEphemeralAgent({
      name: 'ephemeral', model: 'test', systemPrompt: 'system', toolResultGuard: true,
    });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'read' }]);
    const completion = h.framework.runEphemeralToCompletion(created.agent, created.contextManager);
    h.framework.start();
    const result = await completion;
    assert.deepEqual(result, { speech: 'continued', toolCallsCount: 1 });
    assert.deepEqual(h.module.calls, ['one']);
    assert.equal(h.membrane.requests.length, 2);
  } finally { await h.framework.stop(); }
});

test('quiesced scheduler admits a queued guard recovery as a continuation', async () => {
  const h = await harness([[answer()]], { toolResultGuard: true });
  try {
    await h.framework.quiesce();
    h.framework.getAgent('assistant')!.getContextManager().addMessage('user', [{
      type: 'text', text: TOOL_RESULT_GUARD_NOTICE,
    }]);
    // A recovery can be requeued while waiting for provider admission. It
    // must finish the held turn even after the host stops admitting new work.
    (h.framework as unknown as { pendingRequests: Array<Record<string, unknown>> }).pendingRequests.push({
      agentName: 'assistant', reason: 'tool_result_guard_retry', source: 'framework', timestamp: Date.now(),
    });
    await h.framework.runUntilIdle();
    assert.equal(h.membrane.requests.length, 1);
    assert.equal(h.framework.getHostModeStatus().quiesced, true);
  } finally { await h.framework.stop(); }
});

test('native Membrane observes the first refusal even when guard is enabled by a tool mid-stream', async () => {
  const h = await harness([]);
  await h.framework.stop();
  const requests: ProviderRequest[] = [];
  const adapter: ProviderAdapter = {
    name: 'test', usageCacheConvention: 'cache-excluded', supportsModel: () => true,
    complete: async () => { throw new Error('unexpected complete'); },
    stream: async (request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> => {
      requests.push(structuredClone(request));
      const index = requests.length;
      assert.ok(index <= 3, 'must not retry unchanged refused input');
      const content = index === 1 ? [
        { type: 'tool_use', id: 'enable', name: 'agent_settings', input: { action: 'update', tool_result_guard: true } },
        { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
      ] : [{ type: 'text', text: index === 2 ? 'discard-native-partial' : 'continued' }];
      if (index > 1) callbacks.onChunk?.(index === 2 ? 'discard-native-partial' : 'continued');
      return {
        content, stopReason: index === 1 ? 'tool_use' : index === 2 ? 'refusal' : 'end_turn',
        usage: { inputTokens: 20, outputTokens: 5 }, model: 'test',
        raw: { response: { stop_details: { category: 'test-category' } } },
      } as ProviderResponse;
    },
  };
  const framework = await AgentFramework.create({ ...h.base,
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system', refusalHandling: { retries: 4 } }],
    membrane: new RealMembrane(adapter, { formatter: new NativeFormatter() }),
  });
  const routed: string[] = [];
  const outgoing: string[] = [];
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveLocus: () => 'world:test',
    routeSpeech: async (_agent: string, speech: string) => {
      routed.push(speech); return { delivered: true, channelId: 'world:test' };
    },
    sendOutgoingChunk: (_channel: string, _agent: string, _id: string, _index: number, delta: string) => { outgoing.push(delta); },
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  const tokenTraces: string[] = [];
  framework.onTrace((event) => {
    if (event.type === 'inference:tokens') tokenTraces.push(String((event as { content?: unknown }).content));
  });
  try {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'read', metadata: {} });
    await framework.runUntilIdle();
    assert.equal(requests.length, 3);
    assert.match(JSON.stringify(requests[1]), /payload-one/);
    assert.doesNotMatch(JSON.stringify(requests[2]), /payload-one|discard-native-partial|test-category/);
    assert.match(JSON.stringify(requests[2]), /Tool result withheld by the guard/);
    assert.deepEqual(h.module.calls, ['one']);
    assert.equal(extension(framework).get('assistant').tool_result_guard, true);
    assert.deepEqual(h.module.speeches, ['continued']);
    assert.deepEqual(routed, ['continued']);
    assert.doesNotMatch(outgoing.join(''), /discard-native-partial/);
    assert.match(outgoing.join(''), /continued/, 'accepted answer must reach outgoing-stream consumers');
    assert.doesNotMatch(tokenTraces.join(''), /discard-native-partial/, 'inference:tokens must not leak refused text');
    assert.match(tokenTraces.join(''), /continued/);
  } finally { await framework.stop(); }
});

test('backward-compatible direct Agent inference also guards tool results', async () => {
  const h = await harness([], { toolResultGuard: true });
  const responses = [calls('one'), refused(), answer()];
  const requests: NormalizedRequest[] = [];
  (h.membrane as unknown as { stream: (request: NormalizedRequest) => Promise<NormalizedResponse> }).stream = async (request) => {
    requests.push(structuredClone(request));
    const response = responses.shift();
    assert.ok(response);
    return response;
  };
  try {
    const agent = h.framework.getAgent('assistant')!;
    agent.getContextManager().addMessage('user', [{ type: 'text', text: 'read' }]);
    const first = await agent.runInference(h.framework.getAllTools());
    assert.equal(first.toolCalls.length, 1);
    agent.provideToolResult('one', { success: true, data: 'direct-original' });
    const final = await agent.runInference(h.framework.getAllTools());
    assert.deepEqual(final.speechContent, [{ type: 'text', text: 'continued' }]);
    assert.equal(requests.length, 3);
    assert.equal(final.usage?.inputTokens, 20, 'abandoned refused attempt usage is included');
    assert.match(JSON.stringify(requests[1]), /direct-original/);
    assert.doesNotMatch(JSON.stringify(requests[2]), /direct-original|discard-this/);
    assert.equal(toolResults(h.framework)[0].content, TOOL_RESULT_GUARD_NOTICE);
  } finally { await h.framework.stop(); }
});

test('full oversized output survives withholding and reopening as a Chronicle blob', async () => {
  const original = 'original-large-'.repeat(8_000) + 'end-of-original';
  const h = await harness([[calls('large'), refused()], [answer()]], { toolResultGuard: true }, {
    large: { success: true, data: original },
  });
  let originalStopped = false;
  try {
    await h.run();
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<{
      originals: { blobId: string };
    }>;
    const blobId = audit[0].originals.blobId;
    assert.equal(typeof blobId, 'string');
    const blob = h.framework.getStore().getBlob(blobId)!;
    assert.equal(JSON.parse(blob.toString())[0].result.data, original, 'keep pre-truncation bytes');
    await h.framework.stop(); originalStopped = true;
    const restarted = await AgentFramework.create(h.base);
    try {
      assert.deepEqual(restarted.getStore().getBlob(blobId), blob);
      assert.equal(toolResults(restarted)[0].content, TOOL_RESULT_GUARD_NOTICE);
    } finally { await restarted.stop(); }
  } finally { if (!originalStopped) await h.framework.stop(); }
});

// ---------------------------------------------------------------------------
// Review regressions (PR #159): guard effects apply only to a batch that was
// actually SUBMITTED to the provider in the current turn.
// ---------------------------------------------------------------------------

class OmitToolExchange extends PassthroughStrategy {
  select(...args: Parameters<PassthroughStrategy['select']>) {
    return super.select(...args).filter((entry) =>
      !entry.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result'));
  }
}

test('a staged batch omitted by compilation does not claim the refusal; autoRewind proceeds', async () => {
  const h = await harness([[calls('one')], [refused()], [answer()]], {
    toolResultGuard: true, maxStreamTokens: 1, strategy: new OmitToolExchange(),
    refusalHandling: { autoRewind: true },
  });
  try {
    await h.run();
    const guard = h.framework.getAgent('assistant')!.toolResultGuard;
    assert.equal(guard.hasPending, false, 'unsubmitted batch must be settled, not stranded');
    assert.equal(guard.recovering, false);
    assert.doesNotMatch(JSON.stringify(h.membrane.requests[1]), /payload-one/);
    assert.equal(h.membrane.requests.length, 3, 'ordinary refusal rewind retry must run');
    const messages = h.framework.getAgent('assistant')!.getContextManager().getAllMessages();
    assert.match(JSON.stringify(messages), /\[refusal-rewind\]/);
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.ok(audit.some((r) => r.type === 'withheld' && r.reason === 'unsubmitted'));
  } finally { await h.framework.stop(); }
});

test('a turn ended by an endTurn tool settles (accepts) its batch', async () => {
  const h = await harness([[calls('one')]], { toolResultGuard: true },
    { one: { success: true, data: 'payload-one', endTurn: true } });
  try {
    await h.run();
    const guard = h.framework.getAgent('assistant')!.toolResultGuard;
    assert.equal(guard.hasPending, false);
    assert.match(String(toolResults(h.framework)[0].content), /payload-one/);
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.equal(audit.at(-1)?.type, 'accepted');
    assert.equal(audit.at(-1)?.reason, 'turn_ended');
  } finally { await h.framework.stop(); }
});

test('a refusal on the next turn after endTurn uses ordinary refusal handling', async () => {
  const h = await harness([[calls('one')], [refused()], [answer()]], {
    toolResultGuard: true, refusalHandling: { autoRewind: true, retries: 2 },
  }, { one: { success: true, data: 'payload-one', endTurn: true } });
  try {
    await h.run();
    await h.run();
    const messages = h.framework.getAgent('assistant')!.getContextManager().getAllMessages();
    assert.match(JSON.stringify(messages), /\[refusal-rewind\]/, 'autoRewind must not be suppressed');
    assert.equal(h.membrane.requests.length, 3);
  } finally { await h.framework.stop(); }
});

test('budget restart reserves the real wire cost of the pending batch', async () => {
  const big = 'x'.repeat(40_000); // ~10k tokens on the wire, notice is ~20
  const budget = 14_000;
  const h = await harness([[calls('one')], [answer()]], {
    toolResultGuard: true, maxStreamTokens: 1, contextBudgetTokens: budget, maxTokens: 1_000,
  }, { one: { success: true, data: big } });
  try {
    const cm = h.framework.getAgent('assistant')!.getContextManager();
    for (let i = 0; i < 20; i++) {
      cm.addMessage('user', [{ type: 'text', text: `filler-${i} ` + 'y'.repeat(2_000) }]);
    }
    await h.run();
    const rebuilt = h.membrane.requests[1];
    assert.match(JSON.stringify(rebuilt), /xxxxxxxx/, 'pending original still submitted');
    const chars = rebuilt.messages.flatMap((m) => m.content).reduce((n, b) =>
      n + JSON.stringify(b).length, 0);
    assert.ok(Math.ceil(chars / 4) <= budget - 1_000,
      `rebuilt request ~${Math.ceil(chars / 4)} tokens exceeds budget ${budget - 1_000}`);
  } finally { await h.framework.stop(); }
});

test('audit is synced before the pending batch is submitted', async () => {
  const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
  const store = h.framework.getStore();
  const sync = store.sync.bind(store);
  let syncedWhilePending = false;
  (store as { sync: () => void }).sync = () => {
    if (h.framework.getAgent('assistant')!.toolResultGuard.hasPending) syncedWhilePending = true;
    sync();
  };
  let durableAtSubmit = false;
  h.membrane.onSubmit = () => { durableAtSubmit = syncedWhilePending; };
  try {
    await h.run();
    assert.equal(durableAtSubmit, true);
  } finally { (store as { sync: () => void }).sync = sync; await h.framework.stop(); }
});

test('direct API: a transient compile failure does not wedge the guard', async () => {
  const h = await harness([], { toolResultGuard: true });
  const responses = [calls('one'), answer()];
  (h.membrane as unknown as { stream: (request: NormalizedRequest) => Promise<NormalizedResponse> }).stream =
    async () => responses.shift()!;
  try {
    const agent = h.framework.getAgent('assistant')!;
    agent.getContextManager().addMessage('user', [{ type: 'text', text: 'read' }]);
    await agent.runInference(h.framework.getAllTools());
    agent.provideToolResult('one', { success: true, data: 'direct-original' });
    const compile = agent.compileWithInjections.bind(agent);
    let failed = false;
    agent.compileWithInjections = async (...args) => {
      if (!failed) { failed = true; throw new Error('transient compile failure'); }
      return compile(...args);
    };
    await assert.rejects(agent.runInference(h.framework.getAllTools()), /transient compile failure/);
    const final = await agent.runInference(h.framework.getAllTools());
    assert.deepEqual(final.speechContent, [{ type: 'text', text: 'continued' }]);
    assert.equal(toolResults(h.framework).length, 1, 'batch staged exactly once');
    assert.match(String(toolResults(h.framework)[0].content), /direct-original/);
  } finally { await h.framework.stop(); }
});

test('usage of an abandoned guarded round is counted in session totals', async () => {
  const withUsage = (r: NormalizedResponse, input: number) =>
    ({ ...r, details: { ...(r.details ?? {}), usage: { inputTokens: input, outputTokens: 1 } } }) as NormalizedResponse;
  const h = await harness([[calls('one'), withUsage(refused(), 1_000)], [withUsage(answer(), 7)]], { toolResultGuard: true });
  try {
    await h.run();
    const totals = h.framework.getSessionUsage().totals as unknown as Record<string, number>;
    assert.ok(totals.inputTokens >= 1_007, `refused round usage missing: ${JSON.stringify(totals)}`);
  } finally { await h.framework.stop(); }
});

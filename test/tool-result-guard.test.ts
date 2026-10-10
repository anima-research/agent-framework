import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassthroughStrategy, type StoredMessage, type StrategyContext } from '@animalabs/context-manager';
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse, YieldingStreamOptions } from '@animalabs/membrane';
import { Membrane as RealMembrane, NativeFormatter, type ProviderAdapter, type ProviderRequest,
  type ProviderResponse, type StreamCallbacks } from '@animalabs/membrane';
import { AgentFramework, type AgentConfig, type AgentSettingsExtension, type Module, type ModuleContext,
  type ToolCall, type ToolResult, type ProcessEvent, type ProcessState } from '../src/index.js';
import { TOOL_RESULT_GUARD_AUDIT_STATE, TOOL_RESULT_GUARD_NOTICE, withheldResultNotice } from '../src/tool-result-guard.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { JsStore } from '@animalabs/chronicle';

// What a withheld result settles to with no writable workspace (#277): the
// neutral notice, then where the original is kept.
const AUDIT_STUB = withheldResultNotice(null, true);
const UNSAVED_STUB = withheldResultNotice(null, false);

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
  getTools() {
    return [
      { name: 'read', description: 'Read a result', inputSchema: { type: 'object' as const, properties: {} } },
      { name: 'send_message', description: 'Explicit send', inputSchema: { type: 'object' as const, properties: {} } },
    ];
  }
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
    const retried = retry.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.ok(retried.length === 3 && retried.every((b) => b.content === AUDIT_STUB),
      'the retry already says where each original is');
    const guarded = toolResults(h.framework);
    assert.equal(guarded.length, 3);
    assert.ok(guarded.every((block) => block.content === AUDIT_STUB));
    assert.equal(guarded.find((b) => b.toolUseId === 'error')?.isError, true);
    assert.deepEqual(h.module.speeches, ['continued']);
    assert.ok(strategy.snapshots.every((s) => !s.includes('original-text-payload') && !s.includes(image)),
      'background strategy ingress must never see withheld payloads');

    const store = h.framework.getStore();
    const audit = store.getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.match(JSON.stringify(audit[0]), /original-text-payload|original-error-payload/);
    assert.ok(JSON.stringify(audit[0]).includes(image));
    assert.deepEqual(audit.slice(-2).map((r) => r.type), ['withheld', 'annotated']);
    const historical = store.getStateJsonAt(TOOL_RESULT_GUARD_AUDIT_STATE, stagedSequence) as unknown[];
    assert.deepEqual(audit[0], historical[0], 'redaction only appends; original Chronicle record is unchanged');
    const original = structuredClone(audit[0]);
    extension(h.framework).update('assistant', { tool_result_guard: false });
    assert.ok(toolResults(h.framework).every((block) => block.content === AUDIT_STUB));
    await h.framework.stop();
    originalStopped = true;
    const restarted = await AgentFramework.create(h.base);
    try {
      assert.equal(extension(restarted).get('assistant').tool_result_guard, false, 'explicit disable persists');
      assert.ok(toolResults(restarted).every((block) => block.content === AUDIT_STUB));
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
    assert.equal(results.find((b) => b.toolUseId === 'withheld')?.content, AUDIT_STUB);
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
    assert.equal(toolResults(h.framework)[0].content, AUDIT_STUB);
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
    assert.equal(toolResults(h.framework)[0].content, AUDIT_STUB);
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
    const retried = requests[2].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.deepEqual(retried.map((b) => b.content), [AUDIT_STUB], 'the direct retry says where the original is too');
    assert.equal(toolResults(h.framework)[0].content, AUDIT_STUB);
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
      assert.equal(toolResults(restarted)[0].content, AUDIT_STUB);
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

// ---------------------------------------------------------------------------
// Greptile review regressions (PR #159, head 647f081).
// ---------------------------------------------------------------------------

function fakeRegistry(framework: AgentFramework) {
  const routed: string[] = [];
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveLocus: () => 'world:test',
    routeSpeech: async (_agent: string, speech: string) => {
      routed.push(speech); return { delivered: true, channelId: 'world:test' };
    },
    sendOutgoingChunk: () => {},
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  return routed;
}

test('failed audit sync fails closed: originals are never submitted', async () => {
  const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
  const store = h.framework.getStore();
  const sync = store.sync.bind(store);
  (store as { sync: () => void }).sync = () => {
    if (h.framework.getAgent('assistant')!.toolResultGuard.hasPending) throw new Error('disk full');
    sync();
  };
  try {
    await h.run();
    const provided = JSON.stringify(h.membrane.streams[0].receivedToolResults);
    assert.doesNotMatch(provided, /payload-one/, 'non-durable audit must not release originals');
    assert.match(provided, /Tool result withheld by the guard/);
    assert.equal(toolResults(h.framework)[0].content, UNSAVED_STUB);
    const guard = h.framework.getAgent('assistant')!.toolResultGuard;
    assert.equal(guard.hasPending, false);
  } finally { (store as { sync: () => void }).sync = sync; await h.framework.stop(); }
});

test('an aborted stream settles its submitted batch; the next turn neither resubmits nor claims it', async () => {
  const h = await harness([[calls('one')], [refused()], [answer()]], {
    toolResultGuard: true, refusalHandling: { autoRewind: true },
  });
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  try {
    await h.run();
    const guard = h.framework.getAgent('assistant')!.toolResultGuard;
    assert.equal(guard.hasPending, false, 'aborted batch must not stay pending');
    h.membrane.onSubmit = undefined;
    await h.run();
    assert.doesNotMatch(JSON.stringify(h.membrane.requests[1]), /payload-one/, 'old originals must not be resubmitted');
    const messages = h.framework.getAgent('assistant')!.getContextManager().getAllMessages();
    assert.match(JSON.stringify(messages), /\[refusal-rewind\]/, 'ordinary autoRewind must run');
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.ok(audit.some((r) => r.type === 'withheld' && r.reason === 'aborted'));
  } finally { await h.framework.stop(); }
});

test('guard recovery keeps same-turn explicit-send suppression', async () => {
  const h = await harness([[createMockResponse([
    { type: 'tool_use', id: 'send', name: 'test--send_message', input: {} },
    { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
  ], 'tool_use'), refused()], [createMockResponse([{ type: 'text', text: 'postscript' }])]], { toolResultGuard: true });
  const routed = fakeRegistry(h.framework);
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 2);
    assert.ok(!routed.some((text) => text.includes('postscript')), `postscript routed: ${JSON.stringify(routed)}`);
  } finally { await h.framework.stop(); }
});

test('a failed audit append while settling an aborted batch does not block teardown', async () => {
  const h = await harness([[calls('one')], [answer()]], { toolResultGuard: true });
  const store = h.framework.getStore();
  const append = store.appendToStateJson.bind(store);
  let failAborted = true;
  (store as { appendToStateJson: typeof append }).appendToStateJson = (id: string, value: unknown) => {
    if (failAborted && (value as { reason?: string })?.reason === 'aborted') throw new Error('storage down');
    return append(id, value);
  };
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  try {
    await h.run().catch(() => {});
    assert.equal(h.framework.getAgent('assistant')!.toolResultGuard.hasPending, false);
    failAborted = false;
    h.membrane.onSubmit = undefined;
    await h.run();
    assert.equal(h.membrane.requests.length, 2, 'agent must accept a later turn after teardown');
    assert.deepEqual(h.module.speeches.at(-1), 'continued');
  } finally { (store as { appendToStateJson: typeof append }).appendToStateJson = append; await h.framework.stop(); }
});

test('an aborted outcome that failed to append is recorded on the next guard write or stop', async () => {
  const h = await harness([[calls('one')], [calls('two'), answer()]], { toolResultGuard: true });
  const store = h.framework.getStore();
  const append = store.appendToStateJson.bind(store);
  let failAborted = true;
  (store as { appendToStateJson: typeof append }).appendToStateJson = (id: string, value: unknown) => {
    if (failAborted && (value as { reason?: string })?.reason === 'aborted') throw new Error('storage down');
    return append(id, value);
  };
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  try {
    await h.run().catch(() => {});
    failAborted = false;
    h.membrane.onSubmit = undefined;
    await h.run();
    const audit = store.getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    const first = audit[0].batchId;
    const outcome = audit.findIndex((r) => r.batchId === first && r.type === 'withheld' && r.reason === 'aborted');
    assert.ok(outcome > 0, 'lost aborted outcome must be retried');
    const nextStaged = audit.findIndex((r, i) => i > 0 && r.type === 'staged');
    assert.ok(outcome < nextStaged, 'retried outcome lands before the next batch');
  } finally { (store as { appendToStateJson: typeof append }).appendToStateJson = append; await h.framework.stop(); }
});

test('a lost aborted outcome is flushed at stop', async () => {
  const h = await harness([[calls('one')]], { toolResultGuard: true });
  const store = h.framework.getStore();
  const append = store.appendToStateJson.bind(store);
  let failAborted = true;
  (store as { appendToStateJson: typeof append }).appendToStateJson = (id: string, value: unknown) => {
    if (failAborted && (value as { reason?: string })?.reason === 'aborted') throw new Error('storage down');
    return append(id, value);
  };
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  let stopped = false;
  try {
    await h.run().catch(() => {});
    failAborted = false;
    const written: Array<Record<string, unknown>> = [];
    (store as { appendToStateJson: typeof append }).appendToStateJson = (id: string, value: unknown) => {
      if (id === TOOL_RESULT_GUARD_AUDIT_STATE) written.push(value as Record<string, unknown>);
      return append(id, value);
    };
    await h.framework.stop(); stopped = true;
    assert.ok(written.some((r) => r.type === 'withheld' && r.reason === 'aborted'), 'outcome flushed at stop');
  } finally { if (!stopped) await h.framework.stop(); }
});

// ---------------------------------------------------------------------------
// Compression holds (CM 0.12): real Autobiographical compression with the
// guard on (Codex 09-26 P1 repro / review finding #3).
// ---------------------------------------------------------------------------

async function compressionRig() {
  const { ContextManager, AutobiographicalStrategy } = await import('@animalabs/context-manager');
  const { ToolResultGuard } = await import('../src/tool-result-guard.js');
  const dir = mkdtempSync(join(tmpdir(), 'af-guard-compression-')); dirs.push(dir);
  const prompts: string[] = [];
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'test-compression-model', targetChunkTokens: 50, headWindowTokens: 0,
    recentWindowTokens: 0, autoTickOnNewMessage: false, minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
  });
  const cm = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: {
    complete: async (req: unknown) => {
      prompts.push(JSON.stringify(req));
      return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${prompts.length}` }] };
    },
  } as never });
  cm.setToolDefinitions([{ name: 'search', description: 'search', inputSchema: { type: 'object', properties: {} } }]);
  const filler = (n: number) => 'word '.repeat(n);
  for (let i = 0; i < 6; i++) cm.addMessage(i % 2 === 0 ? 'User' : 'Claude', [{ type: 'text', text: filler(30) }]);
  cm.addMessage('Claude', [{ type: 'text', text: filler(20) }, { type: 'tool_use', id: 'tu-1', name: 'search', input: {} }]);
  const guard = new ToolResultGuard('Claude', cm, true);
  const REAL = 'REAL-ACCEPTED-TOOL-OUTPUT';
  const content: ContentBlock[] = [{ type: 'tool_result', toolUseId: 'tu-1', content: REAL }];
  const messageId = guard.storeResults(content, [{ toolUseId: 'tu-1', content: REAL }], []);
  // Deferred messages flushed right behind the staged batch push it out of
  // the protected tail.
  for (let i = 0; i < 6; i++) cm.addMessage(i % 2 === 0 ? 'Claude' : 'User', [{ type: 'text', text: filler(30) }]);
  const drain = async () => {
    const s = strategy as unknown as { compressionQueue: number[] };
    await cm.compile();
    let n = 0;
    while (s.compressionQueue.length > 0 && n++ < 50) await cm.tick();
  };
  return { cm, guard, prompts, drain, messageId, REAL };
}

test('real compression: a pending batch is held; accepted output reaches memory, placeholder never does', async () => {
  const r = await compressionRig();
  try {
    assert.deepEqual([...r.cm.getCompressionHolds()], [r.messageId], 'staged with a compression hold');
    await r.drain();
    assert.ok(r.prompts.length > 0, 'history before the hold still compresses');
    assert.ok(!r.prompts.some((p) => p.includes(TOOL_RESULT_GUARD_NOTICE)), 'placeholder summarized while pending');
    r.guard.submissionResults([{ toolUseId: 'tu-1', content: r.REAL }]);
    r.guard.accept();
    assert.equal(r.cm.getCompressionHolds().size, 0, 'accept releases the hold');
    await r.drain();
    assert.ok(r.prompts.some((p) => p.includes(r.REAL)), 'accepted output must reach the compression request');
    assert.ok(!r.prompts.some((p) => p.includes(TOOL_RESULT_GUARD_NOTICE)), 'placeholder must never be summarized');
  } finally { r.cm.close(); }
});

test('real compression: a withheld batch releases its hold and the placeholder compresses normally', async () => {
  const r = await compressionRig();
  try {
    await r.drain();
    r.guard.submissionResults([{ toolUseId: 'tu-1', content: r.REAL }]);
    assert.ok(r.guard.withhold('test-category'));
    assert.deepEqual([...r.cm.getCompressionHolds()], [r.messageId], 'held until the stub says where the original is');
    await r.guard.whenAnnotated();
    assert.equal(r.cm.getCompressionHolds().size, 0, 'withhold releases the hold once annotated');
    await r.drain();
    assert.ok(r.prompts.some((p) => p.includes(TOOL_RESULT_GUARD_NOTICE)), 'placeholder compresses after release');
    assert.ok(!r.prompts.some((p) => p.includes(r.REAL)), 'withheld output never reaches memory');
  } finally { r.cm.close(); }
});

test('every settlement path releases the hold, even when the audit write fails', async () => {
  const paths: Array<[string, (g: InstanceType<typeof import('../src/tool-result-guard.js').ToolResultGuard>) => void]> = [
    ['accept-submitted', (g) => { g.submissionResults([{ toolUseId: 'tu-1', content: 'x' }]); g.accept(); }],
    ['accept-unsubmitted', (g) => g.accept()],
    ['withhold', (g) => { g.submissionResults([{ toolUseId: 'tu-1', content: 'x' }]); g.withhold('c'); }],
    ['turn-ended', (g) => g.settleTurnEnded()],
    ['unsubmitted', (g) => g.settleUnsubmitted('c')],
    ['abandon', (g) => g.abandon('aborted')],
  ];
  for (const [name, settle] of paths) {
    const r = await compressionRig();
    try {
      const store = r.cm.getStore();
      (store as { appendToStateJson: unknown }).appendToStateJson = () => { throw new Error('storage down'); };
      try { settle(r.guard); } catch { /* audit failure surfaces; hold must still go */ }
      await r.guard.whenAnnotated();
      assert.equal(r.guard.hasPending, false, `${name}: batch cleared`);
      assert.equal(r.cm.getCompressionHolds().size, 0, `${name}: hold released`);
    } finally { r.cm.close(); }
  }
});

for (const failedType of ['staged', 'linked']) {
  test(`storage recovery: failed ${failedType} append continues with placeholders and releases the hold`, async () => {
    const h = await harness([[calls('one'), answer()], [answer()]], { toolResultGuard: true });
    const store = h.framework.getStore();
    const append = store.appendToStateJson.bind(store);
    let failing = true;
    store.appendToStateJson = (id, value) => {
      if (failing && id === TOOL_RESULT_GUARD_AUDIT_STATE && value?.type === failedType) {
        throw new Error(`injected ${failedType} append failure`);
      }
      return append(id, value);
    };
    try {
      await assert.doesNotReject(h.run(), 'storage failure must not strand the live tool loop');
      const agent = h.framework.getAgent('assistant')!;
      assert.equal(agent.state.status, 'idle');
      assert.equal(agent.toolResultGuard.hasPending, false);
      assert.equal(agent.getContextManager().getCompressionHolds().size, 0);
      assert.match(JSON.stringify(h.membrane.streams[0].receivedToolResults), /Tool result withheld/);
      assert.doesNotMatch(JSON.stringify(h.membrane.streams[0].receivedToolResults), /payload-one/);
      failing = false;
      await h.run(); // A normal activation, with no new tool call, retries the audit.
      const records = store.getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
      assert.deepEqual(records.map((r) => r.type), ['staged', 'linked', 'withheld', 'annotated']);
      assert.match(JSON.stringify(records[0]), /payload-one/, 'the original is recoverable after storage returns');
      assert.doesNotMatch(JSON.stringify(h.membrane.requests[1]), /payload-one/);
      assert.deepEqual(h.module.calls, ['one']);
    } finally {
      store.appendToStateJson = append;
      for (const stream of h.membrane.streams) stream.cancel();
      await h.framework.stop();
    }
  });
}

test('storage recovery: failed accepted edit is retried before the next activation without rerunning tools', async () => {
  const h = await harness([[calls('one'), answer()], [answer()]], { toolResultGuard: true });
  const agent = h.framework.getAgent('assistant')!;
  const cm = agent.getContextManager();
  const edit = cm.editMessage.bind(cm);
  let failing = true;
  cm.editMessage = (id, content) => {
    if (failing && JSON.stringify(content).includes('payload-one')) throw new Error('injected edit failure');
    edit(id, content);
  };
  try {
    await h.run();
    assert.equal(agent.state.status, 'idle');
    assert.equal(agent.toolResultGuard.hasPending, false, 'an accepted batch cannot claim another refusal');
    assert.equal(cm.getCompressionHolds().size, 1, 'keep provisional history out of compression until repaired');
    assert.equal(toolResults(h.framework)[0].content, TOOL_RESULT_GUARD_NOTICE);
    assert.throws(() => agent.toolResultGuard.flushUnrecorded(), /injected edit failure/);
    failing = false;
    await h.run();
    assert.match(JSON.stringify(h.membrane.requests[1]), /payload-one/, 'next activation must see the accepted result');
    assert.equal(cm.getCompressionHolds().size, 0);
    const records = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.equal(records.filter((r) => r.type === 'accepted').length, 1);
    assert.deepEqual(h.module.calls, ['one']);
    assert.equal(h.module.speeches.at(-1), 'continued');
    assert.equal(cm.getAllMessages().filter((message) => message.participant === 'assistant'
      && message.content.some((block) => block.type === 'text' && block.text === 'continued')).length, 2);
  } finally { cm.editMessage = edit; await h.framework.stop(); }
});

test('storage recovery: failed accepted edit stays held until the real compressor can see the original', async () => {
  const r = await compressionRig();
  const edit = r.cm.editMessage.bind(r.cm);
  r.cm.editMessage = () => { throw new Error('injected edit failure'); };
  try {
    r.guard.submissionResults([{ toolUseId: 'tu-1', content: r.REAL }]);
    assert.doesNotThrow(() => r.guard.accept());
    assert.equal(r.cm.getCompressionHolds().size, 1);
    await r.drain();
    assert.ok(!r.prompts.some((p) => p.includes(TOOL_RESULT_GUARD_NOTICE)));
    r.cm.editMessage = edit;
    r.guard.flushUnrecorded();
    assert.equal(r.cm.getCompressionHolds().size, 0);
    await r.drain();
    assert.ok(r.prompts.some((p) => p.includes(r.REAL)));
    assert.ok(!r.prompts.some((p) => p.includes(TOOL_RESULT_GUARD_NOTICE)));
  } finally { r.cm.editMessage = edit; r.cm.close(); }
});

test('storage recovery: failed accepted edit and its audit outcome are repaired at stop', async () => {
  const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
  const cm = h.framework.getAgent('assistant')!.getContextManager();
  const edit = cm.editMessage.bind(cm);
  cm.editMessage = () => { throw new Error('injected edit failure'); };
  let stopped = false;
  try {
    await h.run();
    cm.editMessage = edit;
    await h.framework.stop(); stopped = true;
    const restarted = await AgentFramework.create(h.base);
    try {
      assert.match(String(toolResults(restarted)[0].content), /payload-one/);
      const records = restarted.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
      assert.equal(records.at(-1)?.type, 'accepted');
    } finally { await restarted.stop(); }
  } finally { cm.editMessage = edit; if (!stopped) await h.framework.stop(); }
});

test('storage recovery: endTurn never admits a batch whose audit sync failed', async () => {
  const h = await harness([[calls('one')], [answer()]], { toolResultGuard: true }, {
    one: { success: true, data: 'payload-one', endTurn: true },
  });
  const agent = h.framework.getAgent('assistant')!;
  const store = h.framework.getStore();
  const sync = store.sync.bind(store);
  store.sync = () => {
    if (agent.toolResultGuard.hasPending) throw new Error('injected sync failure');
    sync();
  };
  try {
    await h.run();
    assert.equal(toolResults(h.framework)[0].content, UNSAVED_STUB);
    assert.equal(agent.getContextManager().getCompressionHolds().size, 0);
    assert.equal(agent.toolResultGuard.hasPending, false);
    store.sync = sync;
    await h.run();
    assert.doesNotMatch(JSON.stringify(h.membrane.requests[1]), /payload-one/);
    const records = store.getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.deepEqual(records.slice(-2).map((r) => r.type), ['withheld', 'annotated']);
    assert.match(JSON.stringify(records[0]), /payload-one/, 'the original is still archived');
  } finally { store.sync = sync; await h.framework.stop(); }
});

for (const supersedingAction of ['edit', 'branch']) {
  test(`storage recovery: queued acceptance respects an operator ${supersedingAction}`, async () => {
    const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
    const agent = h.framework.getAgent('assistant')!;
    const cm = agent.getContextManager();
    const edit = cm.editMessage.bind(cm);
    cm.editMessage = () => { throw new Error('injected edit failure'); };
    try {
      await h.run();
      cm.editMessage = edit;
      const result = cm.getAllMessages().find((message) => message.content.some((block) => block.type === 'tool_result'))!;
      if (supersedingAction === 'edit') {
        cm.editMessage(result.id, [{ type: 'tool_result', toolUseId: 'one', content: 'operator replacement' }]);
      } else {
        await cm.fork('operator-branch');
      }
      agent.toolResultGuard.flushUnrecorded();
      assert.equal(toolResults(h.framework)[0].content,
        supersedingAction === 'edit' ? 'operator replacement' : TOOL_RESULT_GUARD_NOTICE);
      assert.equal(cm.getCompressionHolds().size, 0);
      const records = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
      assert.equal(records.at(-1)?.historyUpdate, 'superseded');
      assert.match(JSON.stringify(records[0]), /payload-one/, 'original audit remains intact');
    } finally { cm.editMessage = edit; await h.framework.stop(); }
  });
}

test('storage recovery: idle maintenance retries acceptance without a new activation', async () => {
  const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
  const cm = h.framework.getAgent('assistant')!.getContextManager();
  const edit = cm.editMessage.bind(cm);
  cm.editMessage = () => { throw new Error('injected edit failure'); };
  try {
    await h.run();
    assert.equal(cm.getCompressionHolds().size, 1);
    cm.editMessage = edit;
    h.framework.start();
    await h.framework.maintenanceTick();
    assert.equal(cm.getCompressionHolds().size, 0);
    assert.match(String(toolResults(h.framework)[0].content), /payload-one/);
    assert.equal(h.membrane.requests.length, 1);
  } finally { cm.editMessage = edit; await h.framework.stop(); }
});

test('storage recovery: shutdown retries edits queued by its terminating stream', async () => {
  const h = await harness([[calls('one'), answer()]], { toolResultGuard: true });
  const cm = h.framework.getAgent('assistant')!.getContextManager();
  const edit = cm.editMessage.bind(cm);
  let failOnce = true;
  cm.editMessage = (id, content) => {
    if (failOnce) { failOnce = false; throw new Error('injected edit failure'); }
    edit(id, content);
  };
  let stopping: Promise<void> | undefined;
  h.membrane.onSubmit = () => { stopping = h.framework.stop(); };
  try {
    await h.run();
    assert.ok(stopping);
    await stopping;
    const restarted = await AgentFramework.create(h.base);
    try {
      assert.match(String(toolResults(restarted)[0].content), /payload-one/);
      const records = restarted.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
      assert.equal(records.at(-1)?.type, 'accepted');
    } finally { await restarted.stop(); }
  } finally { cm.editMessage = edit; if (stopping) await stopping; else await h.framework.stop(); }
});

// ---------------------------------------------------------------------------
// agent-framework #277: a withheld result says where its original is. The
// guard's neutral notice stays (#159), followed by the place: a workspace
// file when a writable mount takes it, else the guard's audit record.
// ---------------------------------------------------------------------------

async function workspaceHarness(scripts: NormalizedResponse[][], mount: { maxFileSize?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-tool-result-guard-ws-')); dirs.push(dir);
  const mountDir = join(dir, 'mount');
  mkdirSync(mountDir, { recursive: true });
  const membrane = new ScriptMembrane(scripts);
  const module = new ReadModule();
  const workspace = new WorkspaceModule({ mounts: [{
    name: 'work', path: mountDir, mode: 'read-write', watch: 'never',
    ...(mount.maxFileSize !== undefined ? { maxFileSize: mount.maxFileSize } : {}),
  }] });
  const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system', toolResultGuard: true }],
    modules: [module, workspace as unknown as Module], syncIntervalMs: 0 });
  workspace.initStore(framework.getStore());
  const run = async () => {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'read', metadata: {} });
    await framework.runUntilIdle();
  };
  return { framework, membrane, module, workspace, run };
}

/** Delay the framework's tool-results writer (no workspace: it then reports
 *  none), keeping the framework's own wiring and tracking in place. */
function slowSpill(framework: AgentFramework, wait: () => Promise<unknown>) {
  (framework as unknown as { writeToolResultFile: () => Promise<null> }).writeToolResultFile = async () => {
    await wait();
    return null;
  };
}

const SPILLED_STUB = /^Tool result withheld by the guard\. The tool has already executed\. Its full result is in workspace file (work\/tool-results\/\d{4}-\d{2}-\d{2}-withheld-[0-9a-f]{12}-0-one\.txt)\.$/;

test('#277: a withheld original is written to the workspace, and its stub names the file', async () => {
  const h = await workspaceHarness([[calls('one'), refused()], [answer()]]);
  try {
    await h.run();
    const stub = String(toolResults(h.framework)[0].content);
    const path = SPILLED_STUB.exec(stub)?.[1];
    assert.ok(path, `stub names the file: ${stub}`);
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    const staged = (audit[0] as { content: Array<{ toolUseId?: string; content?: unknown }> }).content;
    const admitted = staged.find((b) => b.toolUseId === 'one')?.content;
    assert.match(String(admitted), /payload-one/);
    const file = await h.workspace.readBinary(path);
    assert.ok('data' in file, `the file is readable: ${JSON.stringify(file)}`);
    assert.equal((file as { data: Buffer }).data.toString('utf8'), admitted,
      'the file holds exactly what acceptance would have admitted');
    const retried = h.membrane.requests[1].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.deepEqual(retried.map((b) => b.content), [stub], 'the retry already says where the original is');
    assert.doesNotMatch(stub, /refus|test-category/, "#159's line: no refusal or category in the context");
    assert.deepEqual(audit.at(-1), { ...audit.at(-1), type: 'annotated', results: [{ toolUseId: 'one', path }] });
  } finally { await h.framework.stop(); }
});

test('#277: a failed workspace write says so, and the audit record still keeps the original', async () => {
  const h = await workspaceHarness([[calls('one'), refused()], [answer()]], { maxFileSize: 4 });
  try {
    await h.run();
    const stub = String(toolResults(h.framework)[0].content);
    assert.match(stub, /^Tool result withheld by the guard\. The tool has already executed\. Writing its full result to workspace file work\/tool-results\/\d{4}-\d{2}-\d{2}-withheld-[0-9a-f]{12}-0-one\.txt failed \(.+\), so it is kept only in the guard's audit record \(framework\/tool-result-guard\), for an operator\.$/);
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    const annotated = audit.at(-1) as { type: string; results: Array<{ toolUseId: string; path?: string; error?: string }> };
    assert.equal(annotated.type, 'annotated');
    assert.equal(annotated.results[0].toolUseId, 'one');
    assert.equal(typeof annotated.results[0].error, 'string');
    assert.match(JSON.stringify(audit[0]), /payload-one/, 'the original is in the staged record');
  } finally { await h.framework.stop(); }
});

test('#277: the refusal retry is compiled only once the stub says where the original is', async () => {
  const h = await harness([[calls('one'), refused()], [answer()]], { toolResultGuard: true });
  slowSpill(h.framework, () => new Promise((resolve) => setTimeout(resolve, 100)));
  try {
    await h.run();
    const retried = h.membrane.requests[1].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.deepEqual(retried.map((b) => b.content), [AUDIT_STUB]);
  } finally { await h.framework.stop(); }
});

test("#277: an operator's edit made before the stub is annotated stands, and the hold waits for it", async () => {
  const r = await compressionRig();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    r.guard.setHost({ spill: async () => { entered = true; await gate; return null; }, track: () => {} });
    r.guard.submissionResults([{ toolUseId: 'tu-1', content: r.REAL }]);
    assert.ok(r.guard.withhold('test-category'));
    for (let i = 0; i < 100 && !entered; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(entered, 'the original is being written');
    assert.deepEqual([...r.cm.getCompressionHolds()], [r.messageId], 'held while the original is being written');
    r.cm.editMessage(r.messageId, [{ type: 'tool_result', toolUseId: 'tu-1', content: 'operator replacement' }]);
    release();
    await r.guard.whenAnnotated();
    assert.equal((r.cm.getMessage(r.messageId)!.content[0] as { content: unknown }).content, 'operator replacement');
    assert.equal(r.cm.getCompressionHolds().size, 0);
    const audit = r.cm.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.equal(audit.at(-1)?.type, 'annotated');
    assert.equal(audit.at(-1)?.historyUpdate, 'superseded');
  } finally { r.cm.close(); }
});

test('#277: stop lets an aborted batch\'s stub be annotated before the store closes', async () => {
  const h = await harness([[calls('one')]], { toolResultGuard: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let spills = 0;
  slowSpill(h.framework, () => { spills++; return gate; });
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  let stopped = false;
  try {
    await h.run().catch(() => {});
    for (let i = 0; i < 100 && spills === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(spills, 1, 'the aborted batch is being annotated');
    const stopping = h.framework.stop().then(() => { stopped = true; });
    setTimeout(release, 50);
    await stopping;
    const restarted = await AgentFramework.create(h.base);
    try {
      assert.equal(toolResults(restarted)[0].content, AUDIT_STUB, 'the annotated stub was saved before close');
    } finally { await restarted.stop(); }
  } finally { release(); if (!stopped) await h.framework.stop(); }
});

test('#277: the stub has the same text for each place the original can be', () => {
  const notice = 'Tool result withheld by the guard. The tool has already executed.';
  assert.equal(withheldResultNotice({ path: 'work/tool-results/2026-10-10-withheld-a.txt' }, true),
    `${notice} Its full result is in workspace file work/tool-results/2026-10-10-withheld-a.txt.`);
  assert.equal(withheldResultNotice({ path: 'work/tool-results/x.txt', error: 'disk full' }, true),
    `${notice} Writing its full result to workspace file work/tool-results/x.txt failed (disk full), ` +
    "so it is kept only in the guard's audit record (framework/tool-result-guard), for an operator.");
  assert.equal(withheldResultNotice(null, true),
    `${notice} Its full result is kept in the guard's audit record (framework/tool-result-guard), for an operator.`);
  assert.equal(withheldResultNotice(null, false),
    `${notice} Its full result is kept in the guard's audit record (framework/tool-result-guard), for an operator, ` +
    'though saving that record had failed when this was written.');
});

test('#277: direct API: a request after an aborted batch is compiled once its stub is annotated', async () => {
  const h = await harness([], { toolResultGuard: true });
  const responses: unknown[] = [calls('one'), { aborted: true, reason: 'test-abort' }, answer()];
  const requests: NormalizedRequest[] = [];
  (h.membrane as unknown as { stream: (request: NormalizedRequest) => Promise<unknown> }).stream = async (request) => {
    requests.push(structuredClone(request));
    const response = responses.shift();
    assert.ok(response);
    return response;
  };
  try {
    const agent = h.framework.getAgent('assistant')!;
    slowSpill(h.framework, () => new Promise((resolve) => setTimeout(resolve, 100)));
    agent.getContextManager().addMessage('user', [{ type: 'text', text: 'read' }]);
    await agent.runInference(h.framework.getAllTools());
    agent.provideToolResult('one', { success: true, data: 'direct-original' });
    const aborted = await agent.runInference(h.framework.getAllTools());
    assert.equal(aborted.aborted, true);
    await agent.runInference(h.framework.getAllTools());
    const next = requests[2].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.deepEqual(next.map((b) => b.content), [AUDIT_STUB]);
  } finally { await h.framework.stop(); }
});

test('#277: stop waits for an annotation started by an ephemeral run it has already disposed', async () => {
  const h = await harness([[calls('one')]]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let spills = 0;
  slowSpill(h.framework, () => { spills++; return gate; });
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  let stopped = false;
  try {
    const created = await h.framework.createEphemeralAgent({
      name: 'ephemeral', model: 'test', systemPrompt: 'system', toolResultGuard: true,
    });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'read' }]);
    const completion = h.framework.runEphemeralToCompletion(created.agent, created.contextManager);
    h.framework.start();
    await completion.catch(() => {});
    for (let i = 0; i < 100 && spills === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(spills, 1, "the ephemeral's aborted batch is being annotated");
    assert.equal(h.framework.getAgent('ephemeral') ?? null, null, 'the run was disposed');
    const stopping = h.framework.stop().then(() => { stopped = true; });
    setTimeout(release, 50);
    await stopping;
    const restarted = await AgentFramework.create(h.base);
    try {
      const audit = restarted.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
      assert.ok(audit.some((r) => r.type === 'annotated' && r.agentName === 'ephemeral'),
        'the annotation finished before the store closed');
    } finally { await restarted.stop(); }
  } finally { release(); if (!stopped) await h.framework.stop(); }
});

// ---------------------------------------------------------------------------
// #281's review: each withheld result's file is its own, a branch change stops
// the annotation's writes, and the direct API's refusal retry fits the budget.
// ---------------------------------------------------------------------------

/** The file a written stub names, whatever the naming. */
const stubPath = (stub: string) => /workspace file (\S+\.txt)\.$/.exec(stub)?.[1];

test('#277: a tool use id seen again gets a file of its own, and each stub reads back its own original', async () => {
  const h = await workspaceHarness([[calls('one'), refused()], [answer()], [calls('one'), refused()], [answer()]]);
  try {
    h.module.results.one = { success: true, data: 'first-original' };
    await h.run();
    h.module.results.one = { success: true, data: 'second-original' };
    await h.run();
    const stubs = toolResults(h.framework).map((block) => String(block.content));
    const paths = stubs.map(stubPath);
    assert.equal(paths.length, 2);
    assert.ok(paths[0] && paths[1] && paths[0] !== paths[1], `each stub names a file of its own: ${JSON.stringify(stubs)}`);
    for (const [index, expected] of ['first-original', 'second-original'].entries()) {
      const file = await h.workspace.readBinary(paths[index]!);
      assert.ok('data' in file, `the file is readable: ${JSON.stringify(file)}`);
      assert.match((file as { data: Buffer }).data.toString('utf8'), new RegExp(expected), `stub ${index} reads back its own original`);
    }
  } finally { await h.framework.stop(); }
});

test("#277: results whose ids the writer's cut makes alike still get a file each", async () => {
  // The writer keeps 80 characters of a label; these ids agree in their first 75.
  const shared = 'call_' + 'a'.repeat(70);
  const ids = [`${shared}-1`, `${shared}-2`];
  const h = await workspaceHarness([[calls(...ids), refused()], [answer()]]);
  try {
    await h.run();
    const stubs = toolResults(h.framework).map((block) => String(block.content));
    const paths = stubs.map(stubPath);
    assert.ok(paths[0] && paths[1] && paths[0] !== paths[1], `each stub names a file of its own: ${JSON.stringify(stubs)}`);
    for (const [index, id] of ids.entries()) {
      const file = await h.workspace.readBinary(paths[index]!);
      assert.ok('data' in file, `the file is readable: ${JSON.stringify(file)}`);
      assert.match((file as { data: Buffer }).data.toString('utf8'), new RegExp(`payload-${id}`), `stub ${index} reads back its own original`);
    }
  } finally { await h.framework.stop(); }
});

test('#277: a rollback while an aborted batch is being annotated gets none of its files, and its stub stays as it was', async () => {
  const h = await harness([[calls('one', 'two')]], { toolResultGuard: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const labels: string[] = [];
  // The annotation is held after its first write, where a rollback can land
  // between two writes. (A rollback during a write: the next test.)
  (h.framework as unknown as { writeToolResultFile: (label: string) => Promise<null> }).writeToolResultFile = async (label) => {
    labels.push(label);
    if (labels.length === 1) await gate;
    return null;
  };
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  try {
    await h.run().catch(() => {});
    for (let i = 0; i < 100 && labels.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(labels.length, 1, "the aborted batch's first original is being written");
    const agent = h.framework.getAgent('assistant')!;
    const cm = agent.getContextManager();
    const source = cm.currentBranch().name;
    const batch = cm.getAllMessages().find((m) => m.content.some((b) => b.type === 'tool_result'))!;
    const read = cm.getAllMessages().find((m) => m.content.some((b) => b.type === 'text' && b.text === 'read'))!;
    const rolled = await h.framework.rollbackToMessage('assistant', { messageId: read.id });
    release();
    await agent.toolResultGuard.whenAnnotated();
    assert.equal(labels.length, 1, 'nothing more is written once the branch has changed');
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    const annotated = audit.find((record) => record.type === 'annotated');
    assert.ok(annotated, `the annotation is recorded on ${rolled.targetBranch}: ${JSON.stringify(audit)}`);
    assert.deepEqual(annotated.results, [{ toolUseId: 'one' }, { toolUseId: 'two', skipped: 'branch_changed' }]);
    assert.equal(annotated.historyUpdate, 'superseded');
    await cm.switchBranch(source);
    const kept = cm.getMessage(batch.id)!.content.filter((b) => b.type === 'tool_result');
    assert.deepEqual(kept.map((b) => (b as { content: unknown }).content), [TOOL_RESULT_GUARD_NOTICE, TOOL_RESULT_GUARD_NOTICE],
      'the source branch keeps the plain notice');
  } finally { release(); await h.framework.stop(); }
});

test('#277: a write under way when a rollback lands is refused where it commits, and neither branch gets its file', async () => {
  const h = await workspaceHarness([[calls('one', 'two')]]);
  type Writer = (label: string, text: string, branch?: string) => Promise<{ path: string; error?: string } | null>;
  const framework = h.framework as unknown as { writeToolResultFile: Writer };
  const write = framework.writeToolResultFile.bind(h.framework);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const branches: Array<string | undefined> = [];
  // The first write is held after the guard's branch check and before the
  // workspace commits the file: the rollback lands in between.
  framework.writeToolResultFile = async (label, text, branch) => {
    branches.push(branch);
    if (branches.length === 1) await gate;
    return write(label, text, branch);
  };
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  try {
    await h.run().catch(() => {});
    for (let i = 0; i < 100 && branches.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(branches.length, 1, "the aborted batch's first original is being written");
    const agent = h.framework.getAgent('assistant')!;
    const cm = agent.getContextManager();
    const source = cm.currentBranch().name;
    assert.equal(branches[0], source, "the write names the batch's branch");
    const read = cm.getAllMessages().find((m) => m.content.some((b) => b.type === 'text' && b.text === 'read'))!;
    await h.framework.rollbackToMessage('assistant', { messageId: read.id });
    release();
    await agent.toolResultGuard.whenAnnotated();
    assert.equal(branches.length, 1, 'nothing more is written once the branch has changed');
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    const annotated = audit.find((record) => record.type === 'annotated') as
      { results: Array<{ toolUseId: string; path?: string; error?: string; skipped?: string }> } | undefined;
    assert.ok(annotated, `the annotation is recorded: ${JSON.stringify(audit)}`);
    const [one, two] = annotated.results;
    assert.equal(one.toolUseId, 'one');
    assert.equal(one.error, 'the workspace had left the branch this file is for');
    assert.deepEqual(two, { toolUseId: 'two', skipped: 'branch_changed' });
    const relative = one.path!.replace(/^work\//, '');
    const store = h.framework.getStore();
    assert.equal(store.treeGet('workspace/work/tree', relative), null, 'the branch rolled back to has no file');
    await cm.switchBranch(source);
    assert.equal(store.treeGet('workspace/work/tree', relative), null, "nor does the batch's own branch");
  } finally { release(); await h.framework.stop(); }
});

class BudgetProbe extends PassthroughStrategy {
  store?: { estimateTokens(message: { content: ContentBlock[] }): number };
  select(...args: Parameters<PassthroughStrategy['select']>) {
    this.store = args[0] as unknown as BudgetProbe['store'];
    return super.select(...args);
  }
}

test('#277: direct API: the refusal retry fits the budget, though its stubs are longer than the originals', async () => {
  const probe = new BudgetProbe();
  const budget = 3_000;
  const h = await harness([], { toolResultGuard: true, strategy: probe, contextBudgetTokens: budget, maxTokens: 1_000 });
  const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
  const responses = [calls(...ids), refused(), answer()];
  const requests: NormalizedRequest[] = [];
  (h.membrane as unknown as { stream: (request: NormalizedRequest) => Promise<NormalizedResponse> }).stream = async (request) => {
    requests.push(structuredClone(request));
    const response = responses.shift();
    assert.ok(response);
    return response;
  };
  try {
    const agent = h.framework.getAgent('assistant')!;
    const cm = agent.getContextManager();
    for (let i = 0; i < 200; i++) cm.addMessage('user', [{ type: 'text', text: `filler-${i} ` + 'y'.repeat(200) }]);
    cm.addMessage('user', [{ type: 'text', text: 'read' }]);
    await agent.runInference(h.framework.getAllTools());
    for (const id of ids) agent.provideToolResult(id, { success: true, data: 'x' });
    await agent.runInference(h.framework.getAllTools());
    assert.equal(requests.length, 3);
    const tokens = (request: NormalizedRequest) =>
      request.messages.reduce((n, message) => n + probe.store!.estimateTokens({ content: message.content }), 0);
    const limit = budget - 1_000;
    assert.ok(tokens(requests[1]) <= limit, `the refused attempt fits: ${tokens(requests[1])} <= ${limit}`);
    const retried = requests[2].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.deepEqual(retried.map((b) => b.content), ids.map(() => AUDIT_STUB), 'the retry carries every stub');
    assert.ok(tokens(requests[2]) <= limit, `the retry fits: ${tokens(requests[2])} <= ${limit}`);
  } finally { await h.framework.stop(); }
});

test('#277: writeBinary for a branch writes there, and is refused once the workspace has left it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-guard-write-binary-')); dirs.push(dir);
  mkdirSync(join(dir, 'mount'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  const workspace = new WorkspaceModule({ mounts: [{ name: 'work', path: join(dir, 'mount'), mode: 'read-write', watch: 'never' }] });
  workspace.initStore(store);
  try {
    const tree = 'workspace/work/tree';
    const source = store.currentBranch().name;
    const before = store.currentSequence();
    const here = await workspace.writeBinary('work/tool-results/here.txt', Buffer.from('here'), 'text/plain', { branch: source });
    assert.equal(here.success, true);
    assert.ok(store.treeGet(tree, 'tool-results/here.txt'), 'a write for the current branch lands');
    store.createBranchAt('elsewhere', source, before);
    store.switchBranch('elsewhere');
    const there = await workspace.writeBinary('work/tool-results/there.txt', Buffer.from('there'), 'text/plain', { branch: source });
    assert.deepEqual(there, { success: false, error: 'the workspace had left the branch this file is for', isError: true });
    assert.equal(store.treeGet(tree, 'tool-results/there.txt'), null, 'nothing lands on the branch the workspace is on');
    store.switchBranch(source);
    assert.equal(store.treeGet(tree, 'tool-results/there.txt'), null, 'nor on the branch the write named');
  } finally { store.close(); }
});

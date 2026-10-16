import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassthroughStrategy, type StoredMessage, type StrategyContext } from '@animalabs/context-manager';
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse, YieldingStreamOptions } from '@animalabs/membrane';
import { Membrane as RealMembrane, NativeFormatter, type ProviderAdapter, type ProviderRequest,
  type ProviderResponse, type StreamCallbacks } from '@animalabs/membrane';
import { AgentFramework, type AgentConfig, type AgentSettingsExtension, type Module, type ModuleContext,
  type ToolCall, type ToolResult, type ProcessEvent, type ProcessState } from '../src/index.js';
import { TOOL_RESULT_GUARD_AUDIT_STATE, TOOL_RESULT_GUARD_NOTICE, keptWhenWithheld, withheldResultNotice } from '../src/tool-result-guard.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS } from '../src/tool-result-history.js';
import { JsStore } from '@animalabs/chronicle';

// What a withheld result settles to with no writable workspace (#277): the
// neutral notice, then where the original is kept. Written out, not computed
// by withheldResultNotice, so a change of its wording fails here.
const AUDIT_STUB = 'Tool result withheld by the guard. The tool has already executed. Its result is kept in ' +
  "the guard's audit record (framework/tool-result-guard), for an operator.";
const UNSAVED_STUB = 'Tool result withheld by the guard. The tool has already executed. Its result went to ' +
  "the guard's audit record (framework/tool-result-guard), for an operator, though saving that record had failed " +
  'when the result arrived.';

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
    assert.deepEqual(audit.slice(-3).map((r) => r.type), ['withheld', 'annotated', 'stub_updated']);
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
    routeSpeech: async (_agent: string, speech: string, channelId: string) => {
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

test('explicit mode: a guard retry streams on to the sticky destination delivery uses, and each stream completes under its own id', async () => {
  const h = await harness([
    [createMockResponse([
      { type: 'text', text: '>>#alpha first' },
      { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
    ] as ContentBlock[], 'tool_use'), refused()],
    [answer()],
  ], { toolResultGuard: true, proseRouting: 'explicit', refusalHandling: { retries: 3 } });
  const routed: Array<{ text: string; channelId: string }> = [];
  const streamed: Array<{ channelId: string; delta: string }> = [];
  const completed: Array<{ channelId: string; text: string; inferenceId: string }> = [];
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' } : { error: `no channel ${spec}` },
    routeSpeech: async (_agent: string, speech: string, channelId: string) => {
      routed.push({ text: speech, channelId }); return { delivered: true, channelId };
    },
    sendOutgoingChunk: (channelId: string, _agent: string, _id: string, _index: number, delta: string) => {
      streamed.push({ channelId, delta });
    },
    sendOutgoingComplete: (channelId: string, _agent: string, inferenceId: string, text: string) => {
      completed.push({ channelId, text, inferenceId });
    },
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 2, 'the guard retried once');
    assert.deepEqual(routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'continued', channelId: 'chan-alpha' },
    ], 'delivery keeps the sticky destination across the retry');
    const toAlpha = streamed.filter((d) => d.channelId === 'chan-alpha').map((d) => d.delta).join('');
    assert.match(toAlpha, /continued/, 'the resumed stream follows delivery there');
    assert.doesNotMatch(streamed.map((d) => d.delta).join(''), /discard-this-partial-output/);
    assert.deepEqual(completed.map((c) => ({ channelId: c.channelId, text: c.text })), [
      { channelId: 'chan-alpha', text: 'first' },
      { channelId: 'chan-alpha', text: 'continued' },
    ], 'the stream that handed its turn to the retry completes what it streamed, and so does the retry');
    assert.notEqual(completed[0].inferenceId, completed[1].inferenceId, 'the retry streams under its own inference id');
  } finally { await h.framework.stop(); }
});

test('explicit mode: after a budget restart, the resumed reply streams where delivery sends it, once the earlier posts have gone', { timeout: 15000 }, async () => {
  const h = await harness([
    [
      createMockResponse([
        { type: 'text', text: '>>#alpha first' },
        { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: '>>#cafe second' },
        { type: 'tool_use', id: 'two', name: 'test--read', input: {} },
      ] as ContentBlock[], 'tool_use'),
    ],
    [answer()],
  ], { proseRouting: 'explicit', maxStreamTokens: 1000 });
  const routed: Array<{ text: string; channelId: string }> = [];
  const streamed: Array<{ channelId: string; delta: string }> = [];
  // Each publish that succeeds and each chunk, in the order they happened.
  const order: string[] = [];
  // What delivery had started to publish when the restarted stream wrote.
  let atRestart: string[] | undefined;
  // Delivery of 'first' is held until the resumed stream has written
  // 'continued', so '>>#cafe second' is still queued, and delivery's sticky
  // destination still #alpha, when the restart begins.
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let secondDelivered!: () => void;
  const secondDone = new Promise<void>((resolve) => { secondDelivered = resolve; });
  // The second tool call drops the stream budget, so the turn restarts.
  const handle = h.module.handleToolCall.bind(h.module);
  h.module.handleToolCall = async (call: ToolCall) => {
    if (call.id === 'two') h.framework.getAgent('assistant')!.maxStreamTokens = 1;
    return handle(call);
  };
  const open = h.membrane.streamYielding.bind(h.membrane);
  h.membrane.streamYielding = (request: NormalizedRequest, options?: YieldingStreamOptions) => {
    const stream = open(request, options);
    if (h.membrane.requests.length === 2) {
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[Symbol.asyncIterator] = async function* () {
        const events = { [Symbol.asyncIterator]: iterate } as AsyncIterable<{ type?: string; content?: unknown }>;
        for await (const event of events) {
          yield event;
          if (event.type === 'tokens' && event.content === 'continued') {
            // The premise: the restarted stream is writing while 'first' is
            // still held and '>>#cafe second' is still queued behind it.
            atRestart = routed.map((r) => r.text);
            releaseFirst();
            await secondDone;
          }
        }
      };
    }
    return stream;
  };
  const restarts: string[] = [];
  h.framework.onTrace((event) => {
    if (event.type === 'inference:stream_restarted') restarts.push(String((event as { reason?: string }).reason));
  });
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' }
      : spec === '#cafe' ? { channelId: 'chan-cafe' } : { error: `no channel ${spec}` },
    routeSpeech: async (_agent: string, text: string, channelId: string) => {
      routed.push({ text, channelId });
      if (text === 'first') await firstHeld;
      if (text === 'second') secondDelivered();
      order.push(`published:${text}`);
      return { delivered: true, channelId };
    },
    sendOutgoingChunk: (channelId: string, _agent: string, _id: string, _index: number, delta: string) => {
      streamed.push({ channelId, delta });
      order.push(`chunk:${delta.trim()}`);
    },
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 2);
    assert.ok(restarts.includes('context_budget'), 'the turn restarted for its budget');
    assert.deepEqual(atRestart, ['first'], "the restarted stream wrote while 'first' was held and 'second' still queued");
    assert.deepEqual(routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'second', channelId: 'chan-cafe' },
      { text: 'continued', channelId: 'chan-cafe' },
    ]);
    assert.deepEqual(streamed.filter((d) => d.delta.includes('second')).map((d) => d.channelId), ['chan-cafe'],
      "the second round's prefix starts a new line in the stream, as delivery reads it");
    assert.equal(streamed.some((d) => d.delta.includes('>>')), false, 'no prefix is streamed as text');
    assert.deepEqual(streamed.filter((d) => d.delta.includes('continued')).map((d) => d.channelId), ['chan-cafe'],
      'the resumed stream follows the destination the turn last addressed');
    assert.ok(order.indexOf('chunk:continued') > order.indexOf('published:continued')
      && order.indexOf('published:continued') > order.indexOf('published:first'),
      `the resumed reply streams once its own publish succeeds, after the earlier posts: ${order.join(', ')}`);
  } finally {
    releaseFirst();
    secondDelivered();
    await h.framework.stop();
  }
});

test("explicit mode: a private round's prefix doesn't move where a budget restart resumes", { timeout: 15000 }, async () => {
  // A same-round private think keeps its round's text out of delivery, so
  // its `>>#cafe` sets no destination: the resumed reply goes to #alpha.
  const privateRound = createMockResponse([
    { type: 'text', text: '>>#cafe private plan' },
    { type: 'tool_use', id: 'two', name: 'think', input: { content: 'plan privately' } },
  ] as ContentBlock[], 'tool_use');
  privateRound.usage = { inputTokens: 100, outputTokens: 5 };
  const h = await harness([
    [
      createMockResponse([
        { type: 'text', text: '>>#alpha first\n' },
        { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
      ] as ContentBlock[], 'tool_use'),
      privateRound,
    ],
    [answer()],
  ], { proseRouting: 'explicit', maxStreamTokens: 20, sameRoundThinkTextPolicy: 'private' });
  const routed: Array<{ text: string; channelId: string }> = [];
  const streamed: Array<{ channelId: string; delta: string }> = [];
  const restarts: string[] = [];
  h.framework.onTrace((event) => {
    if (event.type === 'inference:stream_restarted') restarts.push(String((event as { reason?: string }).reason));
  });
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' }
      : spec === '#cafe' ? { channelId: 'chan-cafe' } : { error: `no channel ${spec}` },
    routeSpeech: async (_agent: string, text: string, channelId: string) => {
      routed.push({ text, channelId });
      return { delivered: true, channelId };
    },
    sendOutgoingChunk: (channelId: string, _agent: string, _id: string, _index: number, delta: string) => {
      streamed.push({ channelId, delta });
    },
    handleChannelToolCall: async () => ({ success: true, data: { noted: true } }),
    getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined,
    getChannelTools: () => [{ name: 'think', description: 'Reason privately', inputSchema: { type: 'object', properties: { content: { type: 'string' } } } }],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  try {
    await h.run();
    assert.equal(h.membrane.requests.length, 2);
    assert.ok(restarts.includes('context_budget'), 'the turn restarted for its budget');
    assert.deepEqual(routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'continued', channelId: 'chan-alpha' },
    ], 'the private round moves no destination');
    assert.deepEqual(streamed.filter((d) => d.delta.includes('continued')).map((d) => d.channelId), ['chan-alpha'],
      'the resumed reply streams where it is delivered');
  } finally {
    await h.framework.stop();
  }
});

/**
 * A budget-restart turn whose first round's delivery is held: round one
 * writes `first`, round two `second` and crosses the budget, and the resumed
 * stream writes `continued`. `held` resolves once the resumed stream has
 * handed over its 'complete' and either its reply has gone out or the event
 * loop has turned 200 times, enough for a delivery that doesn't wait on the
 * held one to run; `release` lets the held delivery finish.
 */
async function heldRestart(mode: 'explicit' | 'locus', texts: { first: string; second: string; continued: string }) {
  const secondRound = createMockResponse([
    { type: 'text', text: texts.second },
    { type: 'tool_use', id: 'two', name: 'test--read', input: {} },
  ] as ContentBlock[], 'tool_use');
  secondRound.usage = { inputTokens: 100, outputTokens: 5 };
  const h = await harness([
    [
      createMockResponse([
        { type: 'text', text: texts.first },
        { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
      ] as ContentBlock[], 'tool_use'),
      secondRound,
    ],
    [createMockResponse([{ type: 'text', text: texts.continued }] as ContentBlock[])],
  ], { proseRouting: mode, maxStreamTokens: 20 });
  const routed: Array<{ text: string; channelId: string | null }> = [];
  const streamed: Array<{ channelId: string; delta: string }> = [];
  // What the registry's #cafe names; a test may rebind it while 'first' is held.
  const directory = { cafe: 'chan-cafe' };
  let release!: () => void;
  const firstHeld = new Promise<void>((resolve) => { release = resolve; });
  let resumedEnded!: () => void;
  const ended = new Promise<void>((resolve) => { resumedEnded = resolve; });
  const open = h.membrane.streamYielding.bind(h.membrane);
  h.membrane.streamYielding = (request: NormalizedRequest, options?: YieldingStreamOptions) => {
    const stream = open(request, options);
    if (h.membrane.requests.length === 2) {
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[Symbol.asyncIterator] = async function* () {
        // The framework stops pulling once it has 'complete', so the signal
        // goes with that event rather than after the loop.
        const events = { [Symbol.asyncIterator]: iterate } as AsyncIterable<{ type?: string }>;
        for await (const event of events) {
          if (event.type === 'complete') resumedEnded();
          yield event;
        }
      };
    }
    return stream;
  };
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' }
      : spec === '#cafe' ? { channelId: directory.cafe } : { error: `no channel ${spec}` },
    routeSpeech: async (_agent: string, text: string, channelId: string | null) => {
      routed.push({ text: text.trim(), channelId });
      if (text.trim() === 'first') await firstHeld;
      return { delivered: true, channelId };
    },
    sendOutgoingChunk: (channelId: string, _agent: string, _id: string, _index: number, delta: string) => {
      streamed.push({ channelId, delta });
    },
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  const restarts: string[] = [];
  h.framework.onTrace((event) => {
    if (event.type === 'inference:stream_restarted') restarts.push(String((event as { reason?: string }).reason));
  });
  const run = h.run();
  const held = ended.then(async () => {
    for (let turn = 0; turn < 200 && !routed.some((r) => r.text === texts.continued.replace(/^>>\S+\s*/, '').trim()); turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
  return { h, run, held, release, routed, streamed, restarts, directory };
}

test("explicit mode: a resumed stream's deliveries queue behind the turn's earlier ones", { timeout: 15000 }, async () => {
  // From a review's probe. While 'first' is still posting, '>>#cafe second'
  // is queued behind it, and the resumed reply waits behind both: it then
  // goes to #cafe, where the turn last addressed, as the stream sends it.
  const t = await heldRestart('explicit', { first: '>>#alpha first\n', second: '>>#cafe second', continued: 'continued' });
  try {
    await t.held;
    assert.deepEqual(t.routed.map((r) => r.text), ['first'], 'nothing goes out while the first post is held');
    t.release();
    await t.run;
    assert.equal(t.h.membrane.requests.length, 2);
    assert.ok(t.restarts.includes('context_budget'), 'the turn restarted for its budget');
    assert.deepEqual(t.routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'second', channelId: 'chan-cafe' },
      { text: 'continued', channelId: 'chan-cafe' },
    ], 'the turn delivers in the order it wrote');
    assert.deepEqual(t.streamed.filter((d) => d.delta.includes('continued')).map((d) => d.channelId), ['chan-cafe']);
  } finally {
    t.release();
    await t.h.framework.stop();
  }
});

test("locus mode: a resumed stream's deliveries queue behind the turn's earlier ones", { timeout: 15000 }, async () => {
  const t = await heldRestart('locus', { first: 'first', second: 'second', continued: 'continued' });
  try {
    await t.held;
    assert.deepEqual(t.routed.map((r) => r.text), ['first'], 'nothing goes out while the first post is held');
    t.release();
    await t.run;
    assert.ok(t.restarts.includes('context_budget'), 'the turn restarted for its budget');
    assert.deepEqual(t.routed.map((r) => r.text), ['first', 'second', 'continued'], 'the turn delivers in the order it wrote');
  } finally {
    t.release();
    await t.h.framework.stop();
  }
});

/**
 * The registry stub for one-stream explicit turns: #alpha and #cafe resolve,
 * deliveries, stream chunks and stream completes are recorded, and a `think`
 * tool is offered.
 */
function explicitRegistry(h: Awaited<ReturnType<typeof harness>>) {
  const routed: Array<{ text: string; channelId: string }> = [];
  const streamed: Array<{ channelId: string; delta: string; inferenceId: string }> = [];
  const completed: Array<{ channelId: string; text: string; inferenceId: string }> = [];
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' }
      : spec === '#cafe' ? { channelId: 'chan-cafe' } : { error: `no channel ${spec}` },
    routeSpeech: async (_agent: string, text: string, channelId: string) => {
      routed.push({ text: text.trim(), channelId });
      return { delivered: true, channelId };
    },
    sendOutgoingChunk: (channelId: string, _agent: string, inferenceId: string, _index: number, delta: string) => {
      streamed.push({ channelId, delta, inferenceId });
    },
    sendOutgoingComplete: (channelId: string, _agent: string, inferenceId: string, text: string) => {
      completed.push({ channelId, text, inferenceId });
    },
    handleChannelToolCall: async () => ({ success: true, data: { noted: true } }),
    getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined,
    getChannelTools: () => [{ name: 'think', description: 'Reason privately', inputSchema: { type: 'object', properties: { content: { type: 'string' } } } }],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  return { routed, streamed, completed };
}

test("explicit mode: within one stream, each round after a private round or >>skip_reply streams where delivery sends it", { timeout: 15000 }, async () => {
  // The stream carries what delivery publishes, where it publishes it. A
  // private think's >>#cafe and a >>skip_reply envelope publish nothing and
  // leave the sticky destination at #alpha.
  const h = await harness([[
    createMockResponse([
      { type: 'text', text: '>>#alpha first\n' },
      { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([
      { type: 'text', text: '>>#cafe private plan' },
      { type: 'tool_use', id: 'two', name: 'think', input: { content: 'plan privately' } },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([
      { type: 'text', text: 'middle' },
      { type: 'tool_use', id: 'three', name: 'test--read', input: {} },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([
      { type: 'text', text: '>>skip_reply aside' },
      { type: 'tool_use', id: 'four', name: 'test--read', input: {} },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([{ type: 'text', text: 'later' }] as ContentBlock[]),
  ]], { proseRouting: 'explicit', sameRoundThinkTextPolicy: 'private' });
  const { routed, streamed } = explicitRegistry(h);
  try {
    await h.run();
    assert.deepEqual(routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'middle', channelId: 'chan-alpha' },
      { text: 'later', channelId: 'chan-alpha' },
    ]);
    for (const text of ['middle', 'later']) {
      assert.deepEqual(streamed.filter((d) => d.delta.includes(text)).map((d) => d.channelId), ['chan-alpha'],
        `${text} streams to #alpha`);
    }
  } finally {
    await h.framework.stop();
  }
});

test("explicit mode: a membrane retry within a stream streams none of the refused attempt, and the stream goes on under its id", { timeout: 15000 }, async () => {
  // Round one set #alpha. The membrane then refuses the next attempt and
  // retries it; the retried attempt's unprefixed reply is delivered to
  // #alpha, and streams there too. The refused attempt was never delivered,
  // so it never streamed, and the stream's one `complete` carries both
  // delivered rounds. The stream's inference/lifecycle `started` and its
  // terminal share that one id too.
  const h = await harness([[
    createMockResponse([
      { type: 'text', text: '>>#alpha first\n' },
      { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([{ type: 'text', text: 'continued' }] as ContentBlock[]),
  ]], { proseRouting: 'explicit' });
  const open = h.membrane.streamYielding.bind(h.membrane);
  h.membrane.streamYielding = (request: NormalizedRequest, options?: YieldingStreamOptions) => {
    const stream = open(request, options);
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[Symbol.asyncIterator] = async function* () {
      const events = { [Symbol.asyncIterator]: iterate } as AsyncIterable<{ type?: string; content?: unknown }>;
      for await (const event of events) {
        if (event.type === 'tokens' && event.content === 'continued') {
          yield { type: 'tokens', content: 'refused partial', meta: { type: 'text', visible: true, blockIndex: 0 } };
          yield { type: 'retrying', attempt: 1, maxAttempts: 3 };
        }
        yield event;
      }
    };
    return stream;
  };
  const { routed, streamed, completed } = explicitRegistry(h);
  const lifecycle: Array<{ inferenceId: string; phase: string }> = [];
  (h.framework as unknown as { hookOrchestrator: unknown }).hookOrchestrator = {
    beforeInference: async () => [],
    emitLifecycle: (event: { inferenceId: string; phase: string }) => { lifecycle.push({ inferenceId: event.inferenceId, phase: event.phase }); },
  };
  try {
    await h.run();
    // The stream's `complete` is chained on its deliveries, ahead of this wait.
    await (h.framework as unknown as { proseSpeechChains: Map<string, Promise<void>> }).proseSpeechChains.get('assistant');
    assert.deepEqual(routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'continued', channelId: 'chan-alpha' },
    ]);
    assert.deepEqual(streamed.map((d) => ({ channelId: d.channelId, delta: d.delta })), [
      { channelId: 'chan-alpha', delta: 'first' },
      { channelId: 'chan-alpha', delta: '\n\ncontinued' },
    ], 'the stream carries what was published, and none of the refused attempt');
    assert.equal(new Set(streamed.map((d) => d.inferenceId)).size, 1, 'the retry keeps the stream id');
    assert.deepEqual(completed, [{ channelId: 'chan-alpha', text: 'first\n\ncontinued', inferenceId: streamed[0]!.inferenceId }],
      'one complete closes the stream with everything it carried');
    assert.deepEqual(lifecycle, [
      { inferenceId: streamed[0]!.inferenceId, phase: 'started' },
      { inferenceId: streamed[0]!.inferenceId, phase: 'completed' },
    ], 'the lifecycle notifications start and end the same inference');
  } finally {
    await h.framework.stop();
  }
});

test("explicit mode: a round's later text block starts a new envelope, for delivery and the stream alike", { timeout: 15000 }, async () => {
  // Two text blocks in one round, the second opening with a prefix, the first
  // not ending with a newline. Delivery reads them joined by a newline.
  const h = await harness([[
    createMockResponse([
      { type: 'text', text: '>>#alpha first part' },
      { type: 'text', text: '>>#cafe second' },
      { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([{ type: 'text', text: 'continued' }] as ContentBlock[]),
  ]], { proseRouting: 'explicit' });
  const { routed, streamed } = explicitRegistry(h);
  try {
    await h.run();
    assert.deepEqual(routed.slice(0, 2), [
      { text: 'first part', channelId: 'chan-alpha' },
      { text: 'second', channelId: 'chan-cafe' },
    ]);
    assert.deepEqual(streamed.filter((d) => d.delta.includes('second')).map((d) => d.channelId), ['chan-cafe']);
    assert.equal(streamed.some((d) => d.delta.includes('>>')), false, 'no prefix is streamed as text');
  } finally {
    await h.framework.stop();
  }
});

test("explicit mode: a round's targets are resolved once, when it ends, for its delivery and the resumed stream alike", { timeout: 15000 }, async () => {
  // From a review's probe. Both rounds that name #cafe have ended, and their
  // deliveries wait behind 'first', when the registry's #cafe starts naming
  // another channel. Each goes to the channel #cafe named when its round
  // ended, and streams there: the queued '>>#cafe second', and the resumed
  // '>>#cafe continued', whose text-only round ended before the wait.
  const t = await heldRestart('explicit', { first: '>>#alpha first\n', second: '>>#cafe second', continued: '>>#cafe continued' });
  try {
    await t.held;
    t.directory.cafe = 'chan-rebound';
    t.release();
    await t.run;
    assert.deepEqual(t.routed, [
      { text: 'first', channelId: 'chan-alpha' },
      { text: 'second', channelId: 'chan-cafe' },
      { text: 'continued', channelId: 'chan-cafe' },
    ]);
    assert.deepEqual(t.streamed.filter((d) => d.delta.includes('continued')).map((d) => d.channelId), ['chan-cafe']);
  } finally {
    t.release();
    await t.h.framework.stop();
  }
});


test("a fresh turn and its restart wait behind the earlier turn's speech chain", { timeout: 15000 }, async () => {
  const fresh = createMockResponse([
    { type: 'text', text: '>>#alpha fresh' },
    { type: 'tool_use', id: 'fresh', name: 'test--read', input: {} },
  ] as ContentBlock[], 'tool_use');
  fresh.usage = { inputTokens: 1, outputTokens: 1 };
  const quiet = createMockResponse([
    { type: 'tool_use', id: 'restart', name: 'test--read', input: {} },
  ] as ContentBlock[], 'tool_use');
  quiet.usage = { inputTokens: 100, outputTokens: 5 };
  const reply = createMockResponse([{ type: 'text', text: 'continued' }], 'end_turn');
  const h = await harness([[fresh, quiet], [reply]], { proseRouting: 'explicit', maxStreamTokens: 20 });
  const routed: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const routeSpeech = async (_agent: string, text: string, channelId: string) => {
    routed.push(text.trim());
    if (text.trim() === 'earlier') await held;
    return { delivered: true, channelId };
  };
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' } : { error: 'unknown channel' },
    routeSpeech,
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  const prior = routeSpeech('assistant', 'earlier', 'chan-alpha').then(() => {});
  (h.framework as unknown as { proseSpeechChains: Map<string, Promise<void>> })
    .proseSpeechChains.set('assistant', prior);
  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
  const off = h.framework.onTrace((event) => {
    if (event.type === 'inference:completed') resolveCompleted();
  });
  const bounded = async (promise: Promise<void>, label: string) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), 5000);
      })]);
    } finally { clearTimeout(timer); }
  };
  let run: Promise<void> | undefined;
  try {
    run = h.run();
    void run.catch(() => {});
    await bounded(completed, 'the resumed inference');
    assert.equal(h.membrane.requests.length, 2, 'a budget restart followed the fresh stream');
    assert.deepEqual(routed, ['earlier'], 'both fresh-turn and resumed posts await the prior delivery');
    release();
    await bounded(run, 'the resumed turn to drain');
    assert.deepEqual(routed, ['earlier', 'fresh', 'continued'], 'all three posts keep their order');
  } finally {
    off();
    release();
    try { if (run) await bounded(run, 'cleanup'); } finally { await h.framework.stop(); }
  }
});

test("explicit: a restarted turn whose last response is empty checks for its ' !' after the earlier stream's queued delivery", { timeout: 15000 }, async () => {
  // Stream one's round holds its first envelope's post, with a ' !' envelope
  // queued behind it. The round crosses the budget, the turn restarts, and
  // the restart's response is empty, so nothing but the completion's own
  // wait orders the continuation check after that envelope.
  const quiet = createMockResponse([
    { type: 'text', text: '>>#alpha first\n>>#alpha ! second' },
    { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
  ] as ContentBlock[], 'tool_use');
  quiet.usage = { inputTokens: 100, outputTokens: 5 };
  const empty = createMockResponse([] as ContentBlock[], 'end_turn');
  const after = createMockResponse([{ type: 'text', text: '>>skip_reply' }] as ContentBlock[], 'end_turn');
  const h = await harness([[quiet], [empty], [after]], { proseRouting: 'explicit', maxStreamTokens: 20 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const routed: string[] = [];
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' } : { error: `no channel ${spec}` },
    resolveLocus: () => 'chan-locus',
    routeSpeech: async (_agent: string, text: string, channelId: string) => {
      routed.push(text);
      if (text.trim() === 'first') await held;
      return { delivered: true, channelId };
    },
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  const internals = h.framework as unknown as {
    requestProseContinuation(agent: unknown, routing: { continuation: boolean }): void;
  };
  const check = internals.requestProseContinuation.bind(h.framework);
  const seen: boolean[] = [];
  internals.requestProseContinuation = (agent, routing) => {
    seen.push(routing.continuation);
    check(agent, routing);
  };
  try {
    const run = h.run();
    for (const end = Date.now() + 5000; h.membrane.requests.length < 2 && Date.now() < end;) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(h.membrane.requests.length, 2, 'the turn restarted for its budget');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(seen, [], 'no continuation check while the earlier post is held');
    release();
    await run;
    for (const end = Date.now() + 5000; h.membrane.requests.length < 3 && Date.now() < end;) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      await h.framework.runUntilIdle();
    }
    assert.deepEqual(routed.map((text) => text.trim()), ['first', 'second']);
    assert.equal(seen[0], true, "the completion's check saw the ' !' the queued envelope set");
    assert.equal(h.membrane.requests.length, 3, 'and the continuation ran');
  } finally {
    release();
    await h.framework.stop();
  }
});

test("hybrid: a restarted turn whose last response is empty writes its receipt after the earlier stream's queued delivery", { timeout: 15000 }, async () => {
  // Stream one names #alpha, and its post is held. Its round crosses the
  // budget, so the turn restarts, and the restart's response is empty.
  const quiet = createMockResponse([
    { type: 'text', text: '>>>#alpha first' },
    { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
  ] as ContentBlock[], 'tool_use');
  quiet.usage = { inputTokens: 100, outputTokens: 5 };
  const empty = createMockResponse([] as ContentBlock[], 'end_turn');
  const h = await harness([[quiet], [empty]], { proseRouting: 'hybrid', maxStreamTokens: 20 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const routed: string[] = [];
  (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' } : { error: `no channel ${spec}` },
    resolveLocus: () => 'chan-locus',
    routeSpeech: async (_agent: string, text: string, channelId: string) => {
      routed.push(text);
      if (text.trim() === 'first') await held;
      return { delivered: true, channelId };
    },
    getDefaultPublishChannel: () => null, isChannelOpen: () => true,
    getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
  const receipts = () => h.framework.getAgent('assistant')!.getContextManager().getAllMessages()
    .flatMap((message) => message.content)
    .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text' && (block as { text: string }).text.startsWith('[delivered]'))
    .map((block) => block.text);
  try {
    const run = h.run();
    for (const end = Date.now() + 5000; h.membrane.requests.length < 2 && Date.now() < end;) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(h.membrane.requests.length, 2, 'the turn restarted for its budget');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(receipts(), [], 'no receipt while the earlier post is still held');
    release();
    await run;
    assert.deepEqual(routed.map((text) => text.trim()), ['first']);
    const written = receipts();
    assert.equal(written.length, 1, 'one receipt for the turn');
    assert.match(written[0]!, /chan-alpha/, 'and it names the post that was still queued');
  } finally {
    release();
    await h.framework.stop();
  }
});

test("a fresh turn starts new routing state in every mode, and leaves the earlier turn's as it was", async () => {
  for (const mode of ['explicit', 'hybrid', 'locus'] as const) {
    const h = await harness([[answer()]], { proseRouting: mode });
    type Routing = { pin?: string; hybridHold: boolean;
      continuation: boolean; deliveries: string[]; suppressed: number;
      triggerChannel?: string; locus?: string; engaged: Set<string>; arrivals: Array<{ messageId: string; channelId: string }> };
    const internals = h.framework as unknown as { turnRouting: Map<string, Routing> };
    const earlierFields = (): Routing => ({ pin: 'chan-earlier', hybridHold: true,
      continuation: true, deliveries: ['chan-earlier'], suppressed: 2,
      triggerChannel: 'chan-earlier', locus: 'chan-earlier', engaged: new Set(['chan-earlier']), arrivals: [{ messageId: 'earlier-message', channelId: 'chan-earlier' }] });
    const earlier = earlierFields();
    internals.turnRouting.set('assistant', earlier);
    try {
      await h.run();
      const now = internals.turnRouting.get('assistant');
      assert.notEqual(now, earlier, `${mode}: the new turn has its own routing state`);
      assert.equal(now?.pin, undefined, `${mode}: no sticky destination`);
      assert.equal(now?.hybridHold, false, `${mode}: no hybrid hold`);
      assert.equal(now?.continuation, false, `${mode}: no continuation`);
      assert.deepEqual(now?.deliveries, [], `${mode}: no deliveries carried into the new turn`);
      assert.equal(now?.suppressed, 0, `${mode}: no suppression carried into the new turn`);
      assert.equal(now?.triggerChannel, undefined, `${mode}: no trigger channel carried into the new turn`);
      assert.notEqual(now?.locus, 'chan-earlier', `${mode}: no locus carried into the new turn`);
      assert.deepEqual([...(now?.engaged ?? [])], [], `${mode}: no engaged channels carried into the new turn`);
      assert.deepEqual(now?.arrivals, [], `${mode}: no arrival carried into the new turn`);
      assert.deepEqual(earlier, earlierFields(),
        `${mode}: all earlier-turn routing and receipt state stays with its queued prose`);
    } finally {
      await h.framework.stop();
    }
  }
});

for (const shape of ['text-only', 'trailing'] as const) {
  test(`explicit mode: a turn's ${shape} text is admitted before a module's speech callback runs`, { timeout: 15000 }, async () => {
    // From a review's probe: a speech callback that rebinds #cafe can't move
    // where the turn's final text goes, since that text was admitted first.
    const scripts = shape === 'text-only'
      ? [[createMockResponse([{ type: 'text', text: '>>#cafe final' }] as ContentBlock[])]]
      : [[
        createMockResponse([
          { type: 'text', text: '>>#alpha first\n' },
          { type: 'tool_use', id: 'one', name: 'test--read', input: {} },
        ] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: '>>#cafe final' }] as ContentBlock[]),
      ]];
    const h = await harness(scripts, { proseRouting: 'explicit' });
    let cafe = 'chan-cafe';
    const routed: Array<{ text: string; channelId: string }> = [];
    const streamed: Array<{ channelId: string; delta: string }> = [];
    (h.framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      resolveProseTarget: (spec: string) => spec === '#alpha' ? { channelId: 'chan-alpha' }
        : spec === '#cafe' ? { channelId: cafe } : { error: `no channel ${spec}` },
      routeSpeech: async (_agent: string, text: string, channelId: string) => {
        routed.push({ text: text.trim(), channelId });
        return { delivered: true, channelId };
      },
      sendOutgoingChunk: (channelId: string, _agent: string, _id: string, _index: number, delta: string) => {
        streamed.push({ channelId, delta });
      },
      getDefaultPublishChannel: () => null, isChannelOpen: () => true,
      getDescriptor: () => undefined, getChannelTools: () => [],
    }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
    const modules = (h.framework as unknown as { moduleRegistry: { dispatchSpeech: (...args: unknown[]) => Promise<void> } }).moduleRegistry;
    const dispatch = modules.dispatchSpeech.bind(modules);
    modules.dispatchSpeech = async (...args: unknown[]) => {
      cafe = 'chan-rebound';
      await dispatch(...args);
    };
    try {
      await h.run();
      assert.deepEqual(routed.at(-1), { text: 'final', channelId: 'chan-cafe' });
      assert.ok(streamed.some((d) => d.channelId === 'chan-cafe' && d.delta.includes('final')));
    } finally {
      await h.framework.stop();
    }
  });
}

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
  const messageId = guard.storeResults(content, [{ toolUseId: 'tu-1', content: REAL }], [], undefined, undefined);
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
      assert.equal(String(agent.state.status), 'idle');
      assert.equal(agent.toolResultGuard.hasPending, false);
      assert.equal(agent.getContextManager().getCompressionHolds().size, 0);
      assert.match(JSON.stringify(h.membrane.streams[0].receivedToolResults), /Tool result withheld/);
      assert.doesNotMatch(JSON.stringify(h.membrane.streams[0].receivedToolResults), /payload-one/);
      failing = false;
      await h.run(); // A normal activation, with no new tool call, retries the audit.
      const records = store.getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
      assert.deepEqual(records.map((r) => r.type), ['staged', 'linked', 'withheld', 'annotated', 'stub_updated']);
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
    assert.equal(String(agent.state.status), 'idle');
    assert.equal(agent.toolResultGuard.hasPending, false, 'an accepted batch cannot claim another refusal');
    assert.equal(cm.getCompressionHolds().size, 1, 'keep provisional history out of compression until repaired');
    assert.equal(toolResults(h.framework)[0].content, TOOL_RESULT_GUARD_NOTICE);
    assert.throws(() => agent.toolResultGuard.flushUnrecorded(), /injected edit failure/);
    const busy = (h.framework as unknown as { busyGuards: Map<unknown, string> }).busyGuards;
    assert.equal(busy.has(agent.toolResultGuard), true, 'a queued acceptance edit keeps the guard within reach');
    failing = false;
    await h.run();
    assert.match(JSON.stringify(h.membrane.requests[1]), /payload-one/, 'next activation must see the accepted result');
    assert.equal(cm.getCompressionHolds().size, 0);
    assert.equal(busy.has(agent.toolResultGuard), false, 'and the guard is let go once it lands');
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
    assert.deepEqual(records.slice(-3).map((r) => r.type), ['withheld', 'annotated', 'stub_updated']);
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

async function workspaceHarness(scripts: NormalizedResponse[][], mount: { maxFileSize?: number; autoMaterialize?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-tool-result-guard-ws-')); dirs.push(dir);
  const mountDir = join(dir, 'mount');
  mkdirSync(mountDir, { recursive: true });
  const membrane = new ScriptMembrane(scripts);
  const module = new ReadModule();
  const workspace = new WorkspaceModule({ mounts: [{
    name: 'work', path: mountDir, mode: 'read-write', watch: 'never',
    ...(mount.maxFileSize !== undefined ? { maxFileSize: mount.maxFileSize } : {}),
    ...(mount.autoMaterialize !== undefined ? { autoMaterialize: mount.autoMaterialize } : {}),
  }] });
  const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system', toolResultGuard: true }],
    modules: [module, workspace as unknown as Module], syncIntervalMs: 0 });
  workspace.initStore(framework.getStore());
  const run = async () => {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'read', metadata: {} });
    await framework.runUntilIdle();
  };
  return { framework, membrane, module, workspace, run, mountDir, storePath: join(dir, 'store') };
}

/** Delay the framework's spill of withheld originals (it then reports no
 *  workspace), keeping the framework's own wiring and tracking in place. */
function slowSpill(framework: AgentFramework, wait: () => Promise<unknown>) {
  (framework as unknown as { spillWithheld: () => Promise<null> }).spillWithheld = async () => {
    await wait();
    return null;
  };
}

/** A gate a test opens itself, and a wait for a condition the code under test
 *  makes true (no fixed timers standing in for events). */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `timed out waiting until ${what}`);
}
/** `promise`, or a failure once it has taken `ms`: a wait the code under test
 *  should bound fails the test rather than hanging it. */
async function bounded<T>(promise: Promise<T>, what: string, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally { clearTimeout(timer); }
}

/** Calls of a guard's afterAnnotations, the compile's wait for its stubs. */
function watchCompiles(framework: AgentFramework, agentName = 'assistant') {
  const guard = framework.getAgent(agentName)!.toolResultGuard;
  const watched = { calls: 0 };
  const original = guard.afterAnnotations.bind(guard);
  guard.afterAnnotations = (read) => { watched.calls++; return original(read); };
  return watched;
}

/** Whether stop() has reached its wait for the guards' annotations. */
function watchStopDrain(framework: AgentFramework) {
  const annotations = (framework as unknown as { guardAnnotations: Set<Promise<void>> }).guardAnnotations;
  const watched = { reached: false };
  const iterate = annotations[Symbol.iterator].bind(annotations);
  annotations[Symbol.iterator] = () => { watched.reached = true; return iterate(); };
  return watched;
}

const SPILLED_STUB = /^Tool result withheld by the guard\. The tool has already executed\. Its result is in workspace file (work\/tool-results\/\d{4}-\d{2}-\d{2}-withheld-[0-9a-f]{12}-0-one\.txt)\.$/;

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
    assert.deepEqual(audit.at(-2), { ...audit.at(-2), type: 'annotated', results: [{ toolUseId: 'one', path }] });
    assert.equal(audit.at(-1)?.type, 'stub_updated');
    assert.equal(audit.at(-1)?.historyUpdate, undefined, 'the stub was edited to name the file');
  } finally { await h.framework.stop(); }
});

test('#281: a withheld result over the inline cap is written as stored, and its own note names the whole output', async () => {
  const h = await workspaceHarness([[calls('one'), refused()], [answer()]]);
  (h.module.results as Record<string, ToolResult>).one = { success: true, data: `long-${'x'.repeat(400)}` };
  (h.framework as unknown as { toolResultInlineMaxCharsConfig: number }).toolResultInlineMaxCharsConfig = 100;
  try {
    await h.run();
    const stub = String(toolResults(h.framework)[0].content);
    const path = SPILLED_STUB.exec(stub)?.[1];
    assert.ok(path, `the stub names the withheld file: ${stub}`);
    const withheld = await h.workspace.readBinary(path);
    assert.ok('data' in withheld);
    const text = (withheld as { data: Buffer }).data.toString('utf8');
    // The data is a string, stored as its JSON: 407 characters with the quotes.
    assert.match(text, /^"long-x{94}\n\n\[truncated — showing 100 of 407 chars; full content: workspace file /,
      'the withheld file holds the capped text, as stored');
    const whole = /full content: workspace file (work\/tool-results\/[^\s\]"]+\.txt)/.exec(text)?.[1];
    assert.ok(whole && whole !== path, `its note names the file with the whole output: ${text}`);
    const full = await h.workspace.readBinary(whole);
    assert.ok('data' in full);
    assert.match((full as { data: Buffer }).data.toString('utf8'), /^"long-x{400}"$/);
    assert.doesNotMatch(stub, /full result/, 'the stub says "its result", which the file holds');
  } finally { await h.framework.stop(); }
});

test('#281: a spill that throws is recorded with its error, and the stub names the audit record', async () => {
  const h = await harness([[calls('one'), refused()], [answer()]], { toolResultGuard: true });
  (h.framework as unknown as { spillWithheld: () => Promise<never> }).spillWithheld = async () => {
    throw new Error('the host broke its promise');
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await h.run();
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    const annotated = audit.find((record) => record.type === 'annotated') as { results: unknown[] } | undefined;
    assert.deepEqual(annotated?.results, [{ toolUseId: 'one', error: 'the host broke its promise' }]);
    assert.equal(String(toolResults(h.framework)[0].content), AUDIT_STUB);
  } finally { console.error = originalError; await h.framework.stop(); }
});

test('#277: a failed workspace write says so, and the audit record still keeps the original', async () => {
  const h = await workspaceHarness([[calls('one'), refused()], [answer()]], { maxFileSize: 4 });
  try {
    await h.run();
    const stub = String(toolResults(h.framework)[0].content);
    // The write's own error stays in the audit record and the logs.
    assert.match(stub, /^Tool result withheld by the guard\. The tool has already executed\. Writing its result to workspace file work\/tool-results\/\d{4}-\d{2}-\d{2}-withheld-[0-9a-f]{12}-0-one\.txt failed, so it is kept only in the guard's audit record \(framework\/tool-result-guard\), for an operator\.$/);
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    const annotated = audit.at(-2) as { type: string; results: Array<{ toolUseId: string; path?: string; error?: string }> };
    assert.equal(annotated.type, 'annotated');
    assert.equal(annotated.results[0].toolUseId, 'one');
    assert.equal(typeof annotated.results[0].error, 'string');
    assert.match(JSON.stringify(audit[0]), /payload-one/, 'the original is in the staged record');
  } finally { await h.framework.stop(); }
});

test('#277: the refusal retry is compiled only once the stub says where the original is', async () => {
  // The framework's retry is a new activation (startStreamWithInjections), so
  // this also pins that path's wait.
  const h = await harness([[calls('one'), refused()], [answer()]], { toolResultGuard: true });
  const write = gate();
  let spills = 0;
  slowSpill(h.framework, () => { spills++; return write.opened; });
  const compiles = watchCompiles(h.framework);
  try {
    const running = h.run();
    await until(() => spills === 1 && compiles.calls >= 2, 'the retry is being compiled while the stub is written');
    assert.equal(h.membrane.requests.length, 1, 'the retry waits for the stub');
    write.open();
    await running;
    const retried = h.membrane.requests[1].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.deepEqual(retried.map((b) => b.content), [AUDIT_STUB]);
  } finally { write.open(); await h.framework.stop(); }
});

test("#277: an operator's edit made before the stub is annotated stands, and the hold waits for it", async () => {
  const r = await compressionRig();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    r.guard.setHost({ deadline: () => Infinity, spill: async () => { entered = true; await gate; return null; }, track: () => {}, idle: () => {} });
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
    assert.equal(audit.at(-2)?.type, 'annotated');
    assert.equal(audit.at(-1)?.type, 'stub_updated');
    assert.equal(audit.at(-1)?.historyUpdate, 'superseded');
  } finally { r.cm.close(); }
});

test('#277: stop lets an aborted batch\'s stub be annotated before the store closes', async () => {
  const h = await harness([[calls('one')]], { toolResultGuard: true });
  const write = gate();
  let spills = 0;
  slowSpill(h.framework, () => { spills++; return write.opened; });
  const drain = watchStopDrain(h.framework);
  let modulesStopped = false;
  const stopModule = h.module.stop.bind(h.module);
  h.module.stop = async () => { modulesStopped = true; await stopModule(); };
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  let stopped = false;
  try {
    await h.run().catch(() => {});
    await until(() => spills === 1, 'the aborted batch is being annotated');
    const stopping = h.framework.stop().then(() => { stopped = true; });
    await until(() => drain.reached, 'stop waits for the annotation');
    assert.equal(modulesStopped, false, 'modules and the store wait for the annotation');
    assert.equal(stopped, false);
    write.open();
    await stopping;
    assert.equal(modulesStopped, true);
    const restarted = await AgentFramework.create(h.base);
    try {
      assert.equal(toolResults(restarted)[0].content, AUDIT_STUB, 'the annotated stub was saved before close');
    } finally { await restarted.stop(); }
  } finally { write.open(); if (!stopped) await h.framework.stop(); }
});

test('#277: the stub has the same text for each place the original can be', () => {
  const notice = 'Tool result withheld by the guard. The tool has already executed.';
  const audit = "the guard's audit record (framework/tool-result-guard), for an operator";
  const unsaved = `${audit}, though saving that record had failed when the result arrived`;
  assert.equal(withheldResultNotice({ path: 'work/tool-results/2026-10-10-withheld-a.txt' }, true),
    `${notice} Its result is in workspace file work/tool-results/2026-10-10-withheld-a.txt.`);
  assert.equal(withheldResultNotice({ path: 'work/tool-results/2026-10-10-withheld-a.txt' }, false),
    `${notice} Its result is in workspace file work/tool-results/2026-10-10-withheld-a.txt.`);
  // A failed write's own error text isn't the model's to read.
  assert.equal(withheldResultNotice({ path: 'work/tool-results/x.txt', error: 'EACCES: /srv/host/secret' }, true),
    `${notice} Writing its result to workspace file work/tool-results/x.txt failed, so it is kept only in ${audit}.`);
  // The audit record is said to keep it only when that record was saved.
  assert.equal(withheldResultNotice({ path: 'work/tool-results/x.txt', error: 'disk full' }, false),
    `${notice} Writing its result to workspace file work/tool-results/x.txt failed, so it went only to ${unsaved}.`);
  // A write still under way when the host stopped waiting.
  assert.equal(withheldResultNotice({ path: 'work/tool-results/y.txt', unfinished: true }, true),
    `${notice} Its result was still being written to workspace file work/tool-results/y.txt when this note ` +
    `was made; if that file is missing, it is kept in ${audit}.`);
  assert.equal(withheldResultNotice({ path: 'work/tool-results/y.txt', unfinished: true }, false),
    `${notice} Its result was still being written to workspace file work/tool-results/y.txt when this note ` +
    `was made; if that file is missing, it went to ${unsaved}.`);
  assert.equal(withheldResultNotice(null, true), `${notice} Its result is kept in ${audit}.`);
  assert.equal(withheldResultNotice(null, false), `${notice} Its result went to ${unsaved}.`);
  assert.equal(withheldResultNotice(null, true), AUDIT_STUB);
  assert.equal(withheldResultNotice(null, false), UNSAVED_STUB);
  // A skipped write reads as no write at all.
  for (const skipped of ['workspace_unanswered', 'branch_changed'] as const) {
    assert.equal(withheldResultNotice({ skipped }, true), AUDIT_STUB);
    assert.equal(withheldResultNotice({ skipped }, false), UNSAVED_STUB);
  }
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
  const write = gate();
  let spills = 0;
  try {
    const agent = h.framework.getAgent('assistant')!;
    slowSpill(h.framework, () => { spills++; return write.opened; });
    const compiles = watchCompiles(h.framework);
    agent.getContextManager().addMessage('user', [{ type: 'text', text: 'read' }]);
    await agent.runInference(h.framework.getAllTools());
    agent.provideToolResult('one', { success: true, data: 'direct-original' });
    const aborted = await agent.runInference(h.framework.getAllTools());
    assert.equal(aborted.aborted, true);
    await until(() => spills === 1, 'the aborted batch is being annotated');
    const before = compiles.calls;
    const next = agent.runInference(h.framework.getAllTools());
    await until(() => compiles.calls > before, 'the next request is being compiled while the stub is written');
    assert.equal(requests.length, 2, 'the next request waits for the stub');
    write.open();
    await next;
    const results = requests[2].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.deepEqual(results.map((b) => b.content), [AUDIT_STUB]);
  } finally { write.open(); await h.framework.stop(); }
});

test('#277: stop waits for an annotation started by an ephemeral run it has already disposed', async () => {
  const h = await harness([[calls('one')]]);
  const write = gate();
  let spills = 0;
  slowSpill(h.framework, () => { spills++; return write.opened; });
  const drain = watchStopDrain(h.framework);
  let modulesStopped = false;
  const stopModule = h.module.stop.bind(h.module);
  h.module.stop = async () => { modulesStopped = true; await stopModule(); };
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
    await until(() => spills === 1, "the ephemeral's aborted batch is being annotated");
    assert.equal(h.framework.getAgent('ephemeral') ?? null, null, 'the run was disposed');
    const stopping = h.framework.stop().then(() => { stopped = true; });
    await until(() => drain.reached, 'stop waits for the annotation');
    assert.equal(modulesStopped, false, 'modules and the store wait for the annotation');
    write.open();
    await stopping;
    const restarted = await AgentFramework.create(h.base);
    try {
      const audit = restarted.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
      assert.ok(audit.some((r) => r.type === 'annotated' && r.agentName === 'ephemeral'),
        'the annotation finished before the store closed');
    } finally { await restarted.stop(); }
  } finally { write.open(); if (!stopped) await h.framework.stop(); }
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
  (h.framework as unknown as { spillWithheld: (label: string) => Promise<null> }).spillWithheld = async (label) => {
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
    // The first write went to the slowed spill, which wrote nothing.
    assert.deepEqual(annotated.results, [{ toolUseId: 'one', skipped: 'no_workspace_file' }, { toolUseId: 'two', skipped: 'branch_changed' }]);
    assert.equal(audit.find((record) => record.type === 'stub_updated')?.historyUpdate, 'superseded');
    await cm.switchBranch(source);
    const kept = cm.getMessage(batch.id)!.content.filter((b) => b.type === 'tool_result');
    assert.deepEqual(kept.map((b) => (b as { content: unknown }).content), [TOOL_RESULT_GUARD_NOTICE, TOOL_RESULT_GUARD_NOTICE],
      'the source branch keeps the plain notice');
  } finally { release(); await h.framework.stop(); }
});

test('#277: a write under way when a rollback lands is refused where it commits, recorded as skipped for the branch change, and neither branch gets its file', async () => {
  const h = await workspaceHarness([[calls('one', 'two')]]);
  type Writer = (label: string, text: string, branch?: string) => Promise<{ path: string; error?: string } | null>;
  const framework = h.framework as unknown as { writeToolResultFile: Writer };
  const write = framework.writeToolResultFile.bind(h.framework);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const branches: Array<string | undefined> = [];
  const labels: string[] = [];
  // The guard's branch check and the workspace's commit run with nothing
  // yielding between them. This wrapper adds a wait there, so a rollback
  // lands in between, and the test pins the commit's own check, the one that
  // holds should an await ever come between them. writeBinary's check alone
  // is pinned by the test after this one.
  framework.writeToolResultFile = async (label, text, branch) => {
    branches.push(branch);
    labels.push(label);
    if (branches.length === 1) await gate;
    return write(label, text, branch);
  };
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  const traces: Array<{ type: string }> = [];
  h.framework.onTrace((event) => traces.push(event as { type: string }));
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
    assert.deepEqual(annotated.results, [{ toolUseId: 'one', skipped: 'branch_changed' }, { toolUseId: 'two', skipped: 'branch_changed' }],
      'the declined write names no path, since no file was written, and the next is not started');
    assert.ok(!traces.some((event) => event.type === 'tool:spill_failed'), 'a declined write is not traced as a failed spill');
    const relative = `tool-results/${labels[0].replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}.txt`;
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
    assert.deepEqual(there, { success: false, error: 'the workspace had left the branch this file is for', isError: true,
      data: { branchLeft: true } }, 'declined, and marked so, not a failed write');
    assert.equal(store.treeGet(tree, 'tool-results/there.txt'), null, 'nothing lands on the branch the workspace is on');
    store.switchBranch(source);
    assert.equal(store.treeGet(tree, 'tool-results/there.txt'), null, 'nor on the branch the write named');
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
// sw-af281's review: the annotation's waits are bounded and cover every
// compile, its record survives a failed stub edit, and the stub says only
// what is so.
// ---------------------------------------------------------------------------

test('#281: a write still under way at the deadline is named as unfinished, and nothing waits on it longer', async () => {
  const h = await workspaceHarness([[calls('one', 'two'), refused()], [answer()]]);
  (h.framework as unknown as { withheldSpillDeadlineMs: number }).withheldSpillDeadlineMs = 50;
  const stalled = gate();
  let writes = 0;
  (h.framework as unknown as { writeToolResultFile: () => Promise<null> }).writeToolResultFile = async () => {
    writes++;
    await stalled.opened;
    return null;
  };
  let stopped = false;
  try {
    await bounded(h.run(), 'the run, with its write stalled');
    assert.equal(writes, 1, "once the workspace stopped answering, the batch's next result isn't written");
    assert.equal(h.membrane.requests.length, 2, 'the retry went out without the write');
    const [one, two] = toolResults(h.framework).map((block) => String(block.content));
    assert.match(one, /^Tool result withheld by the guard\. The tool has already executed\. Its result was still being written to workspace file work\/tool-results\/\d{4}-\d{2}-\d{2}-withheld-[0-9a-f]{12}-0-one\.txt when this note was made; if that file is missing, it is kept in the guard's audit record \(framework\/tool-result-guard\), for an operator\.$/);
    assert.equal(two, AUDIT_STUB);
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    const annotated = audit.find((record) => record.type === 'annotated') as { results: Array<Record<string, unknown>> };
    assert.equal(annotated.results[0].unfinished, true);
    assert.deepEqual(annotated.results[1], { toolUseId: 'two', skipped: 'workspace_unanswered' });
    await bounded(h.framework.stop(), 'stop, with the write still stalled');
    stopped = true;
    assert.equal(writes, 1, 'stop finished with the write still stalled');
  } finally { stalled.open(); if (!stopped) await h.framework.stop(); }
});

test("#281: a stub edit that keeps failing leaves the record of the written file and keeps the batch's hold until it lands", async () => {
  const h = await workspaceHarness([[calls('one'), refused()], [answer()], [answer()]]);
  const cm = h.framework.getAgent('assistant')!.getContextManager() as unknown as {
    editMessage: (id: unknown, content: ContentBlock[]) => unknown;
    getCompressionHolds(): Set<unknown>;
  };
  const edit = cm.editMessage.bind(cm);
  let failing = true;
  let attempts = 0;
  cm.editMessage = (id, content) => {
    if (JSON.stringify(content).includes('Its result is in workspace file')) {
      attempts++;
      if (failing) throw new Error('injected stub edit failure');
    }
    return edit(id, content);
  };
  // The write waits until the refusal retry's compile is waiting for it, so
  // the stub's edit fails only where the guard handles it.
  const framework = h.framework as unknown as { writeToolResultFile: (...args: unknown[]) => Promise<unknown> };
  const writeFile = framework.writeToolResultFile.bind(h.framework);
  const write = gate();
  framework.writeToolResultFile = async (...args) => { await write.opened; return writeFile(...args); };
  const compiles = watchCompiles(h.framework);
  const audit = () => h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
  try {
    const running = h.run();
    await until(() => compiles.calls === 2, 'the refusal retry waits for the stub');
    write.open();
    await running;
    assert.ok(attempts >= 3, `made at once, retried with the queue, and again before the retry was compiled: ${attempts}`);
    const annotated = audit().find((record) => record.type === 'annotated') as { results: Array<{ path?: string }> };
    const path = annotated.results[0].path;
    assert.ok(path && SPILLED_STUB.test(`${TOOL_RESULT_GUARD_NOTICE} Its result is in workspace file ${path}.`),
      `the record names the written file though the edit failed: ${JSON.stringify(annotated)}`);
    assert.equal(toolResults(h.framework)[0].content, TOOL_RESULT_GUARD_NOTICE, 'the stub is still the bare notice');
    const retried = h.membrane.requests[1].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.deepEqual(retried.map((b) => b.content), [TOOL_RESULT_GUARD_NOTICE], 'the retry went out with the store still failing');
    assert.equal(audit().some((record) => record.type === 'stub_updated'), false, 'the edit is still queued');
    assert.equal(cm.getCompressionHolds().size, 1, 'and still holds the batch out of summaries');
    const guard = h.framework.getAgent('assistant')!.toolResultGuard;
    const busy = (h.framework as unknown as { busyGuards: Map<unknown, string> }).busyGuards;
    assert.equal(busy.has(guard), true, 'the framework keeps the guard within reach while its edit waits');
    failing = false;
    await h.run();
    assert.equal(toolResults(h.framework)[0].content, `${TOOL_RESULT_GUARD_NOTICE} Its result is in workspace file ${path}.`);
    assert.equal(audit().at(-1)?.type, 'stub_updated');
    assert.equal(audit().at(-1)?.historyUpdate, undefined);
    assert.equal(cm.getCompressionHolds().size, 0, 'released once it landed');
    assert.equal(busy.has(guard), false, 'and lets it go once the edit lands, with no maintenance pass');
  } finally { write.open(); await h.framework.stop(); }
});

test('#281: a stub edit that failed is retried before the refusal retry is compiled, so the retry says where the original is', async () => {
  const h = await harness([[calls('one'), refused()], [answer()]], { toolResultGuard: true });
  const write = gate();
  slowSpill(h.framework, () => write.opened);
  const cm = h.framework.getAgent('assistant')!.getContextManager() as unknown as {
    editMessage: (id: unknown, content: ContentBlock[]) => unknown;
  };
  const edit = cm.editMessage.bind(cm);
  let attempts = 0;
  cm.editMessage = (id, content) => {
    if (JSON.stringify(content).includes('Its result is kept in')) {
      attempts++;
      // Both tries the annotation makes fail; the next succeeds.
      if (attempts <= 2) throw new Error('injected stub edit failure');
    }
    return edit(id, content);
  };
  const compiles = watchCompiles(h.framework);
  try {
    const running = h.run();
    await until(() => compiles.calls === 2, 'the refusal retry waits for the stub');
    write.open();
    await running;
    assert.equal(attempts, 3);
    const retried = h.membrane.requests[1].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.deepEqual(retried.map((b) => b.content), [AUDIT_STUB]);
  } finally { write.open(); await h.framework.stop(); }
});

test("#281: when the record of where each original went can't be saved at first, the stub is still edited, and the records keep their order", async () => {
  const h = await workspaceHarness([[calls('one'), refused()], [answer()]]);
  const store = h.framework.getStore();
  const append = store.appendToStateJson.bind(store);
  let failures = 0;
  store.appendToStateJson = (id, value) => {
    if (id === TOOL_RESULT_GUARD_AUDIT_STATE && (value as { type?: string } | undefined)?.type === 'annotated' && failures === 0) {
      failures++;
      throw new Error('injected annotated append failure');
    }
    return append(id, value);
  };
  try {
    await h.run();
    assert.equal(failures, 1);
    const stub = String(toolResults(h.framework)[0].content);
    const path = SPILLED_STUB.exec(stub)?.[1];
    assert.ok(path, `the stub names the file: ${stub}`);
    const audit = store.getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.deepEqual(audit.slice(-3).map((record) => record.type), ['withheld', 'annotated', 'stub_updated']);
    assert.deepEqual(audit.at(-2)?.results, [{ toolUseId: 'one', path }]);
    const branch = h.framework.getAgent('assistant')!.getContextManager().currentBranch().name;
    for (const record of audit.slice(-3)) assert.equal(record.sourceBranch, branch, `${String(record.type)} names its branch`);
  } finally { store.appendToStateJson = append; await h.framework.stop(); }
});

test('#281: a compile waits for an annotation that began while it waited for another', async () => {
  const r = await compressionRig();
  try {
    const first = gate();
    const second = gate();
    let entered = 0;
    r.guard.setHost({ deadline: () => Infinity, spill: async () => {
      entered++;
      await (entered === 1 ? first.opened : second.opened);
      return null;
    }, track: () => {}, idle: () => {} });
    r.guard.submissionResults([{ toolUseId: 'tu-1', content: r.REAL }]);
    assert.ok(r.guard.withhold('test-category'));
    await until(() => entered === 1, 'the first annotation is writing');
    const stub = (id: unknown) => (r.cm.getMessage(id as typeof r.messageId)!.content[0] as { content: unknown }).content;
    let secondId: unknown;
    let reads = 0;
    const compiled = r.guard.afterAnnotations(async () => { reads++; return [stub(r.messageId), stub(secondId)]; });
    // A second batch settles while the compile waits for the first annotation.
    r.cm.addMessage('Claude', [{ type: 'tool_use', id: 'tu-2', name: 'search', input: {} }]);
    secondId = r.guard.storeResults([{ type: 'tool_result', toolUseId: 'tu-2', content: 'SECOND' }],
      [{ toolUseId: 'tu-2', content: 'SECOND' }], [], undefined, undefined);
    r.guard.submissionResults([{ toolUseId: 'tu-2', content: 'SECOND' }]);
    assert.ok(r.guard.withhold('test-category'));
    first.open();
    await until(() => entered === 2, 'the second annotation is writing');
    assert.equal(reads, 0, 'the compile waits for it too');
    second.open();
    assert.deepEqual(await bounded(compiled, 'the compile'), [AUDIT_STUB, AUDIT_STUB]);
    assert.equal(reads, 1);
  } finally { r.cm.close(); }
});

test("#281: a disposed run's failed stub edit is retried by maintenance and at stop", async () => {
  const h = await harness([[calls('one')]]);
  slowSpill(h.framework, async () => {});
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  let stopped = false;
  try {
    const created = await h.framework.createEphemeralAgent({
      name: 'ephemeral', model: 'test', systemPrompt: 'system', toolResultGuard: true,
    });
    const cm = created.contextManager as unknown as { editMessage: (id: unknown, content: ContentBlock[]) => unknown };
    const edit = cm.editMessage.bind(cm);
    let failing = true;
    let attempts = 0;
    cm.editMessage = (id, content) => {
      if (JSON.stringify(content).includes('Its result is kept in')) {
        attempts++;
        if (failing) throw new Error('injected stub edit failure');
      }
      return edit(id, content);
    };
    created.contextManager.addMessage('user', [{ type: 'text', text: 'read' }]);
    const completion = h.framework.runEphemeralToCompletion(created.agent, created.contextManager);
    h.framework.start();
    await completion.catch(() => {});
    await created.agent.toolResultGuard.whenAnnotated();
    assert.equal(h.framework.getAgent('ephemeral') ?? null, null, 'the run was disposed');
    assert.ok(attempts >= 2, `made at once and retried with the queue: ${attempts}`);
    assert.equal(created.agent.toolResultGuard.idle, false, 'and still queued');
    const before = attempts;
    await (h.framework as unknown as { runQueuedMaintenance(): Promise<void> }).runQueuedMaintenance();
    assert.ok(attempts > before, "maintenance retries the disposed run's queue");
    failing = false;
    await h.framework.stop();
    stopped = true;
    assert.equal(created.agent.toolResultGuard.idle, true, 'stop retried it, and it landed');
    const restarted = await AgentFramework.create(h.base);
    try {
      const audit = restarted.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
      assert.ok(audit.some((record) => record.type === 'stub_updated' && record.agentName === 'ephemeral'),
        "the disposed run's stub edit landed before the store closed");
    } finally { await restarted.stop(); }
  } finally { if (!stopped) await h.framework.stop(); }
});

test("#281: a disposed run's failed acceptance edit is retried by maintenance, and its guard is let go once it lands", async () => {
  const h = await harness([[calls('one'), answer()]]);
  const maintain = () => (h.framework as unknown as { runQueuedMaintenance(): Promise<void> }).runQueuedMaintenance();
  const busy = (h.framework as unknown as { busyGuards: Map<unknown, string> }).busyGuards;
  try {
    const created = await h.framework.createEphemeralAgent({
      name: 'ephemeral', model: 'test', systemPrompt: 'system', toolResultGuard: true,
    });
    const cm = created.contextManager as unknown as { editMessage: (id: unknown, content: ContentBlock[]) => unknown };
    const edit = cm.editMessage.bind(cm);
    let failing = true;
    let attempts = 0;
    cm.editMessage = (id, content) => {
      if (JSON.stringify(content).includes('payload-one')) {
        attempts++;
        if (failing) throw new Error('injected acceptance edit failure');
      }
      return edit(id, content);
    };
    created.contextManager.addMessage('user', [{ type: 'text', text: 'read' }]);
    const completion = h.framework.runEphemeralToCompletion(created.agent, created.contextManager);
    h.framework.start();
    await bounded(completion, 'the ephemeral run');
    const guard = created.agent.toolResultGuard;
    assert.equal(h.framework.getAgent('ephemeral') ?? null, null, 'the run was disposed');
    assert.equal(guard.idle, false, 'with its acceptance edit queued');
    assert.equal(busy.has(guard), true, 'which keeps its guard within reach');
    const before = attempts;
    await maintain();
    assert.ok(attempts > before, "maintenance retries the disposed run's acceptance edit");
    assert.equal(busy.has(guard), true, 'and keeps the guard while the edit fails');
    failing = false;
    await maintain();
    assert.equal(guard.idle, true, 'the edit landed');
    assert.equal(busy.has(guard), false, 'and the guard is let go');
  } finally { await h.framework.stop(); }
});

test('#281: batches behind one stalled write cost one deadline: no write starts until it settles', async () => {
  const h = await workspaceHarness([
    [calls('one'), refused()], [answer()],
    [calls('two'), refused()], [answer()],
    [calls('three'), refused()], [answer()],
  ]);
  (h.framework as unknown as { withheldSpillDeadlineMs: number }).withheldSpillDeadlineMs = 50;
  const framework = h.framework as unknown as {
    writeToolResultFile: (...args: unknown[]) => Promise<unknown>;
    stalledSpills: Set<Promise<void>>;
  };
  const writeFile = framework.writeToolResultFile.bind(h.framework);
  const stalled = gate();
  let writes = 0;
  framework.writeToolResultFile = async (...args) => {
    writes++;
    if (writes === 1) await stalled.opened;
    return writeFile(...args);
  };
  const annotated = () => (h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>)
    .filter((record) => record.type === 'annotated') as Array<{ results: Array<Record<string, unknown>> }>;
  try {
    await bounded(h.run(), 'the first batch');
    await bounded(h.run(), 'the second batch');
    assert.equal(writes, 1, "no write starts while the first is still under way, for this agent's next batch either");
    assert.equal(annotated()[0].results[0].unfinished, true);
    assert.deepEqual(annotated()[1].results, [{ toolUseId: 'two', skipped: 'workspace_unanswered' }]);
    assert.equal(toolResults(h.framework)[1].content, AUDIT_STUB);
    stalled.open();
    await until(() => framework.stalledSpills.size === 0, 'the stalled write settles');
    await bounded(h.run(), 'the third batch');
    assert.equal(writes, 2, 'once it has settled, the next original is written');
    assert.ok(typeof annotated()[2].results[0].path === 'string' && annotated()[2].results[0].unfinished === undefined);
  } finally { stalled.open(); await h.framework.stop(); }
});

test('#281: a write declined for a branch the workspace left stops the writes, and a stub edited after the branch came back names the audit record', async () => {
  const h = await workspaceHarness([[calls('one', 'two'), refused()], [answer()]]);
  let writes = 0;
  // Declined where it commits, as when the branch changed while the write was
  // under way; the store is back on the batch's branch by the time it ends,
  // as after an undo and a redo.
  (h.framework as unknown as { writeToolResultFile: () => Promise<unknown> }).writeToolResultFile = async () => {
    writes++;
    return { path: 'work/tool-results/declined.txt', branchLeft: true };
  };
  try {
    await bounded(h.run(), 'the run');
    assert.equal(writes, 1, 'no write starts after the decline');
    assert.deepEqual(toolResults(h.framework).map((block) => block.content), [AUDIT_STUB, AUDIT_STUB]);
    const audit = h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    const annotated = audit.find((record) => record.type === 'annotated') as { results: Array<Record<string, unknown>> };
    assert.deepEqual(annotated.results, [
      { toolUseId: 'one', skipped: 'branch_changed' },
      { toolUseId: 'two', skipped: 'branch_changed' },
    ]);
  } finally { await h.framework.stop(); }
});

test('#281: stop during a compile that waits for an annotation lets no provider stream be driven after it', async () => {
  const h = await workspaceHarness([[calls('one'), refused()], [answer()]]);
  const framework = h.framework as unknown as { writeToolResultFile: (...args: unknown[]) => Promise<unknown> };
  const writeFile = framework.writeToolResultFile.bind(h.framework);
  const write = gate();
  framework.writeToolResultFile = async (...args) => { await write.opened; return writeFile(...args); };
  const compiles = watchCompiles(h.framework);
  const traces: string[] = [];
  h.framework.onTrace((event) => traces.push((event as { type: string }).type));
  let driven = 0;
  const stream = h.membrane.streamYielding.bind(h.membrane);
  h.membrane.streamYielding = (...args) => {
    const result = stream(...args);
    const iterate = result[Symbol.asyncIterator].bind(result);
    result[Symbol.asyncIterator] = () => { driven++; return iterate(); };
    return result;
  };
  let stopped = false;
  try {
    const running = h.run();
    await until(() => compiles.calls === 2, 'the refusal retry waits for the stub');
    const stopping = h.framework.stop();
    write.open();
    await bounded(stopping, 'stop');
    stopped = true;
    // Nothing is left to drive, so the run ends too: the refused stream's
    // entry went with the retry it started.
    await bounded(running, 'the run');
    assert.equal(h.membrane.requests.length, 2, 'the retry was compiled once its stub was written');
    assert.equal(driven, 1, 'only the original stream was driven; the retry sends nothing');
    assert.equal(traces.includes('inference:completed'), false, 'but, compiled after stop began, it was never driven');
  } finally { write.open(); if (!stopped) await h.framework.stop(); }
});

test('#281: writes that stalled together each hold the workspace as unanswered until it settles', async () => {
  const h = await workspaceHarness([]);
  const framework = h.framework as unknown as {
    withheldSpillDeadlineMs: number;
    writeToolResultFile: (label: string) => Promise<unknown>;
    spillWithheld: (label: string, text: string, branch: string) => Promise<unknown>;
  };
  framework.withheldSpillDeadlineMs = 30;
  const gates = new Map<string, ReturnType<typeof gate>>([['a', gate()], ['b', gate()]]);
  const started: string[] = [];
  framework.writeToolResultFile = async (label) => {
    started.push(label);
    await gates.get(label)?.opened;
    return { path: `work/tool-results/${label}.txt` };
  };
  const branch = h.framework.getAgent('assistant')!.getContextManager().currentBranch().name;
  try {
    // Two agents' writes start together, and both outlive their deadline. The
    // deadline's timer doesn't hold the process open, so the wait goes through
    // bounded, whose timer does.
    const [a, b] = await bounded(
      Promise.all([framework.spillWithheld('a', 'A', branch), framework.spillWithheld('b', 'B', branch)]),
      'both writes reach their deadline',
    );
    assert.deepEqual([a, b], [{ path: 'work/tool-results/a.txt', unfinished: true }, { path: 'work/tool-results/b.txt', unfinished: true }]);
    gates.get('b')!.open();
    await until(() => (h.framework as unknown as { stalledSpills: Set<unknown> }).stalledSpills.size === 1, 'b settles');
    assert.deepEqual(await framework.spillWithheld('c', 'C', branch), { skipped: 'workspace_unanswered' },
      'one stalled write settling leaves the other holding the workspace');
    gates.get('a')!.open();
    await until(() => (h.framework as unknown as { stalledSpills: Set<unknown> }).stalledSpills.size === 0, 'both settle');
    assert.deepEqual(await framework.spillWithheld('d', 'D', branch), { path: 'work/tool-results/d.txt' });
    assert.deepEqual(started, ['a', 'b', 'd']);
  } finally { for (const g of gates.values()) g.open(); await h.framework.stop(); }
});

test("#281: a disposed run's guard is forgotten once its annotation ends with nothing queued, without a maintenance pass", async () => {
  const h = await harness([[calls('one')]]);
  slowSpill(h.framework, async () => {});
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  try {
    const created = await h.framework.createEphemeralAgent({
      name: 'ephemeral', model: 'test', systemPrompt: 'system', toolResultGuard: true,
    });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'read' }]);
    const completion = h.framework.runEphemeralToCompletion(created.agent, created.contextManager);
    h.framework.start();
    await completion.catch(() => {});
    await created.agent.toolResultGuard.whenAnnotated();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.framework.getAgent('ephemeral') ?? null, null, 'the run was disposed');
    assert.equal(created.agent.toolResultGuard.idle, true);
    const remembered = (h.framework as unknown as { busyGuards: Map<unknown, string> }).busyGuards;
    assert.equal(remembered.has(created.agent.toolResultGuard), false, 'nothing keeps the disposed guard');
  } finally { await h.framework.stop(); }
});

test("#281: a file whose copy on disk fails is still in the workspace's tree, and the stub names it", async () => {
  const h = await workspaceHarness([[calls('one'), refused()], [answer()]], { autoMaterialize: true });
  // A file where the directory should be: the copy on disk fails for anyone, root included.
  writeFileSync(join(h.mountDir, 'tool-results'), 'not a directory');
  try {
    await h.run();
    const stub = String(toolResults(h.framework)[0].content);
    const path = SPILLED_STUB.exec(stub)?.[1];
    assert.ok(path, `the stub names the file: ${stub}`);
    const file = await h.workspace.readBinary(path);
    assert.ok('data' in file, `the workspace reads it: ${JSON.stringify(file)}`);
    assert.match((file as { data: Buffer }).data.toString('utf8'), /payload-one/);
    assert.equal(existsSync(join(h.mountDir, path.replace(/^work\//, ''))), false, 'its copy on disk failed');
    const annotated = (h.framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>)
      .find((record) => record.type === 'annotated') as { results: Array<Record<string, unknown>> };
    assert.deepEqual(annotated.results, [{ toolUseId: 'one', path }]);
  } finally { await h.framework.stop(); }
});

test("#281: a conversation fork seeded while its template's stub is written copies the stub that names the original", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-guard-fork-')); dirs.push(dir);
  const membrane = new ScriptMembrane([[calls('one')]]);
  const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system', toolResultGuard: true }],
    modules: [new ReadModule()], syncIntervalMs: 0,
    conversations: { templateAgent: 'assistant', bind: { channel: 'mention' } } });
  const write = gate();
  let spills = 0;
  slowSpill(framework, () => { spills++; return write.opened; });
  membrane.onSubmit = () => {
    const stream = membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  try {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'read', metadata: {} });
    await framework.runUntilIdle().catch(() => {});
    await until(() => spills === 1, "the template's aborted batch is being annotated");
    const compiles = watchCompiles(framework);
    const internals = framework as unknown as { createConversationAgent(name: string, channelId: string): Promise<{
      getContextManager(): { getAllMessages(): Array<{ content: ContentBlock[] }> } }> };
    const forking = internals.createConversationAgent('assistant-chan-g1', 'world:chan');
    await until(() => compiles.calls > 0, "the fork's seed waits for the template's stub");
    write.open();
    const fork = await forking;
    const seeded = fork.getContextManager().getAllMessages()
      .flatMap((message) => message.content.filter((block) => block.type === 'tool_result'));
    assert.deepEqual(seeded.map((block) => (block as { content: unknown }).content), [AUDIT_STUB]);
  } finally { write.open(); await framework.stop(); }
});

test('#281: a compile during which an annotation began is compiled again once it is done', async () => {
  const r = await compressionRig();
  try {
    const write = gate();
    let entered = false;
    r.guard.setHost({ deadline: () => Infinity, spill: async () => { entered = true; await write.opened; return null; }, track: () => {}, idle: () => {} });
    r.guard.submissionResults([{ toolUseId: 'tu-1', content: r.REAL }]);
    let reads = 0;
    const stub = () => (r.cm.getMessage(r.messageId)!.content[0] as { content: unknown }).content;
    const compiled = r.guard.afterAnnotations(async () => {
      reads++;
      // A settlement lands during the compile, as a previous frame's teardown can.
      if (reads === 1) assert.ok(r.guard.withhold('test-category'));
      return stub();
    });
    await until(() => entered, 'the annotation is writing');
    write.open();
    assert.equal(await compiled, AUDIT_STUB);
    assert.equal(reads, 2, 'compiled again once the annotation was done');
  } finally { r.cm.close(); }
});

test('#281: a request preview never waits on a workspace write, though the next request does', async () => {
  const h = await harness([[calls('one')], [answer()]], { toolResultGuard: true });
  const write = gate();
  let spills = 0;
  slowSpill(h.framework, () => { spills++; return write.opened; });
  h.membrane.onSubmit = () => {
    const stream = h.membrane.streams.at(-1)!;
    queueMicrotask(() => stream.cancel());
  };
  try {
    await h.run().catch(() => {});
    await until(() => spills === 1, 'the aborted batch is being annotated');
    // Rollback, undo and redo report a preview: it must not wait on the write.
    const preview = await h.framework.previewActivation('assistant');
    const previewed = preview.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.deepEqual(previewed.map((b) => b.content), [TOOL_RESULT_GUARD_NOTICE], 'the preview shows the stub as it stands');
    const compiles = watchCompiles(h.framework);
    const running = h.run();
    await until(() => compiles.calls > 0, 'the next request is being compiled');
    assert.equal(h.membrane.requests.length, 1, 'the next request waits for the stub');
    write.open();
    await running;
    const sent = h.membrane.requests[1].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.deepEqual(sent.map((b) => b.content), [AUDIT_STUB]);
  } finally { write.open(); await h.framework.stop(); }
});

test('#281: an annotation that starts while modules stop writes no file, and is saved before the store closes', async () => {
  const h = await workspaceHarness([]);
  const agent = h.framework.getAgent('assistant')!;
  const framework = h.framework as unknown as { writeToolResultFile: (...args: unknown[]) => Promise<unknown> };
  const writeFile = framework.writeToolResultFile.bind(h.framework);
  let writes = 0;
  framework.writeToolResultFile = async (...args) => { writes++; return writeFile(...args); };
  const stopModule = h.module.stop.bind(h.module);
  h.module.stop = async () => {
    // A settlement during shutdown, as a direct-API call that stop doesn't cancel can make.
    agent.toolResultGuard.storeResults([{ type: 'tool_result', toolUseId: 'late', content: 'late-original' }],
      [{ toolUseId: 'late', content: 'late-original' }], [], undefined, undefined);
    agent.toolResultGuard.abandon('stopping');
    await stopModule();
  };
  await h.framework.stop();
  assert.equal(writes, 0, 'nothing is written to the stopping workspace');
  const restarted = await AgentFramework.create({ storePath: h.storePath, membrane: new ScriptMembrane([]).asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system', toolResultGuard: true }], modules: [], syncIntervalMs: 0 });
  try {
    assert.deepEqual(toolResults(restarted).map((block) => block.content), [AUDIT_STUB]);
    const audit = restarted.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<Record<string, unknown>>;
    assert.deepEqual(audit.slice(-3).map((record) => record.type), ['withheld', 'annotated', 'stub_updated']);
    assert.deepEqual(audit.at(-2)?.results, [{ toolUseId: 'late', skipped: 'no_workspace_file' }]);
  } finally { await restarted.stop(); }
});

test('#277: a write for a branch that waits for its mount while the branch changes is refused, and neither branch gets it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-guard-write-binary-')); dirs.push(dir);
  mkdirSync(join(dir, 'mount'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  const workspace = new WorkspaceModule({ mounts: [{ name: 'work', path: join(dir, 'mount'), mode: 'read-write', watch: 'never' }] });
  workspace.initStore(store);
  try {
    const tree = 'workspace/work/tree';
    const source = store.currentBranch().name;
    const before = store.currentSequence();
    // Hold the mount's turn, as a pass on it would: the write queues behind it.
    const internals = workspace as unknown as {
      mounts: Map<string, unknown>;
      withMount: (mount: unknown, fn: () => Promise<void>) => Promise<void>;
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = internals.withMount(internals.mounts.get('work'), () => gate);
    const writing = workspace.writeBinary('work/tool-results/late.txt', Buffer.from('late'), 'text/plain', { branch: source });
    store.createBranchAt('elsewhere', source, before);
    store.switchBranch('elsewhere');
    release();
    await held;
    assert.deepEqual(await writing, { success: false, error: 'the workspace had left the branch this file is for', isError: true,
      data: { branchLeft: true } });
    assert.equal(store.treeGet(tree, 'tool-results/late.txt'), null, 'nothing lands on the branch switched to');
    store.switchBranch(source);
    assert.equal(store.treeGet(tree, 'tool-results/late.txt'), null, 'nor on the branch the write named');
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
// #277's second half: a withheld result keeps the file lists its tool marked
// (ToolResult.keepWhenWithheld) inline in its stub. materialize, sync and
// delete mark theirs; nothing else does.
// ---------------------------------------------------------------------------

const LISTS = ' Kept from its result: ';
/** The file lists a stub kept, parsed; undefined when it kept none. */
const keptLists = (stub: string) => stub.includes(LISTS) ? JSON.parse(stub.slice(stub.indexOf(LISTS) + LISTS.length)) : undefined;
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) =>
  createMockResponse([{ type: 'tool_use', id, name, input }], 'tool_use');

test('#277: a stub keeps the file lists after where the original is, for each place it can be', () => {
  const notice = 'Tool result withheld by the guard. The tool has already executed.';
  const lists = '{"materialized":[{"mount":"work","path":"LOG.md"}]}';
  assert.equal(withheldResultNotice({ path: 'work/tool-results/x.txt' }, true, lists),
    `${notice} Its result is in workspace file work/tool-results/x.txt. Kept from its result: ${lists}`);
  assert.equal(withheldResultNotice({ path: 'work/tool-results/x.txt', error: 'disk full' }, true, lists),
    `${notice} Writing its result to workspace file work/tool-results/x.txt failed, ` +
    `so it is kept only in the guard's audit record (framework/tool-result-guard), for an operator. Kept from its result: ${lists}`);
  assert.equal(withheldResultNotice({ path: 'work/tool-results/y.txt', unfinished: true }, true, lists),
    `${notice} Its result was still being written to workspace file work/tool-results/y.txt when this note was made; ` +
    `if that file is missing, it is kept in the guard's audit record (framework/tool-result-guard), for an operator. ` +
    `Kept from its result: ${lists}`);
  assert.equal(withheldResultNotice(null, false, lists),
    `${notice} Its result went to the guard's audit record (framework/tool-result-guard), for an operator, ` +
    `though saving that record had failed when the result arrived. Kept from its result: ${lists}`);
  assert.equal(withheldResultNotice(null, true, undefined), AUDIT_STUB, 'nothing kept: the stub is as before');
});

test('#277: a result keeps the fields its tool marked, in the order marked, cut at the inline cap', () => {
  const data = { materialized: [{ mount: 'work', path: 'LOG.md' }], count: 1, deleted: [{ mount: 'work', path: 'old.txt' }],
    skipped: [{ mount: 'work', reason: 'a.txt: divergent' }] };
  assert.equal(keptWhenWithheld({ success: true, data, keepWhenWithheld: ['deleted', 'materialized'] }, undefined),
    '{"deleted":[{"mount":"work","path":"old.txt"}],"materialized":[{"mount":"work","path":"LOG.md"}]}');
  assert.equal(keptWhenWithheld({ success: true, data: { materialized: [], count: 0 }, keepWhenWithheld: ['deleted', 'materialized'] }, undefined),
    '{"materialized":[]}', 'a marked field the result lacks is left out; an empty list is kept');
  for (const result of [
    { success: true, data },
    { success: true, data, keepWhenWithheld: [] },
    { success: true, data, keepWhenWithheld: ['absent'] },
    { success: true, data: 'text', keepWhenWithheld: ['length'] },
    { success: true, data: [{ path: 'a' }], keepWhenWithheld: ['0'] },
    { success: false, isError: true, error: 'failed', data: { path: 'work/a.txt' }, keepWhenWithheld: ['path'] },
    // A failure is success false, whatever isError says.
    { success: false, isError: false, error: 'failed', data: { path: 'work/a.txt' }, keepWhenWithheld: ['path'] },
    // No data at all, with marks.
    { success: true, data: null, keepWhenWithheld: ['path'] },
    { success: true, keepWhenWithheld: ['path'] },
  ]) assert.equal(keptWhenWithheld(result as never, undefined), undefined, `keeps nothing: ${JSON.stringify(result)}`);
  const long = { written: Array.from({ length: 200 }, (_, i) => `file-${i}.txt`) };
  const cut = keptWhenWithheld({ success: true, data: long, keepWhenWithheld: ['written'] }, 1000)!;
  const whole = JSON.stringify(long);
  assert.ok(whole.length > 1000);
  // The note says what was cut and where the rest is, not "original was N",
  // which would read as the whole result's size.
  assert.equal(cut, `${whole.slice(0, 1000)} [cut at the inline cap: 1000 of these fields' ${whole.length} characters; ` +
    'the whole result is where this note says]');
  // A cut never leaves half a surrogate pair.
  // '{"name":"' is 9 characters and each emoji 2, so a cap of 14 falls inside the third.
  const emoji = keptWhenWithheld({ success: true, data: { name: '\u{1F600}'.repeat(10) }, keepWhenWithheld: ['name'] }, 14)!;
  const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  assert.doesNotMatch(emoji, loneSurrogate, `well-formed: ${JSON.stringify(emoji)}`);
  assert.match(emoji, /^\{"name":"\u{1F600}\u{1F600} \[cut at the inline cap: 13 of these fields' 31 characters;/u);
});

test('#277: a withheld batch keeps what each marked result listed; an unmarked one keeps nothing, and its file has everything', async () => {
  const h = await workspaceHarness([[calls('marked', 'plain'), refused()], [answer()]]);
  h.module.results.marked = { success: true, data: { written: ['LOG.md'], detail: 'payload-marked' }, keepWhenWithheld: ['written'] };
  try {
    await h.run();
    const [marked, plain] = toolResults(h.framework).map((block) => String(block.content));
    assert.deepEqual(keptLists(marked), { written: ['LOG.md'] });
    assert.doesNotMatch(marked, /payload-marked/, 'only the marked field is kept');
    assert.match(marked, /^Tool result withheld by the guard\. The tool has already executed\. Its result is in workspace file work\/tool-results\/\S+-0-marked\.txt\. Kept from its result: /);
    assert.equal(keptLists(plain), undefined);
    assert.match(plain, /Its result is in workspace file work\/tool-results\/\S+-1-plain\.txt\.$/);
    const file = await h.workspace.readBinary(/workspace file (\S+\.txt)\./.exec(marked)![1]);
    assert.match((file as { data: Buffer }).data.toString('utf8'), /payload-marked/, 'the file holds the whole result');
    const retried = h.membrane.requests[1].messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.deepEqual(retried.map((b) => b.content), [marked, plain], 'the retry already carries the lists');
    assert.doesNotMatch(marked, /refus|test-category/, "#159's line: no refusal or category in the context");
  } finally { await h.framework.stop(); }
});

test('#277: a marked result skipped for a branch change keeps its fields in the stub that names the audit record', async () => {
  const h = await workspaceHarness([[calls('marked', 'plain'), refused()], [answer()]]);
  h.module.results.marked = { success: true, data: { written: ['LOG.md'], detail: 'payload-marked' }, keepWhenWithheld: ['written'] };
  // Declined where it commits, and the store is back on the batch's branch by
  // the edit, as after an undo and a redo.
  (h.framework as unknown as { writeToolResultFile: () => Promise<unknown> }).writeToolResultFile = async () =>
    ({ path: 'work/tool-results/declined.txt', branchLeft: true });
  try {
    await bounded(h.run(), 'the run');
    const [marked, plain] = toolResults(h.framework).map((block) => String(block.content));
    assert.equal(plain, AUDIT_STUB);
    assert.ok(marked.startsWith(`${AUDIT_STUB} Kept from its result: `), marked);
    assert.deepEqual(keptLists(marked), { written: ['LOG.md'] });
  } finally { await h.framework.stop(); }
});

test('#277: with no writable workspace the stub still keeps the file lists, cut at the agent\'s inline cap', async () => {
  const written = Array.from({ length: 200 }, (_, i) => `file-${i}.txt`);
  const h = await harness([[calls('marked'), refused()], [answer()]], { toolResultGuard: true },
    { marked: { success: true, data: { written }, keepWhenWithheld: ['written'] } });
  try {
    const spill = [...(h.framework as unknown as {
      collectAgentSettingsExtensions(): Map<string, AgentSettingsExtension>;
    }).collectAgentSettingsExtensions().values()].find((ext) => ext.keys.includes('tool_result_inline_max_chars'))!;
    spill.update('assistant', { tool_result_inline_max_chars: 1000 });
    await h.run();
    const stub = String(toolResults(h.framework)[0].content);
    const whole = JSON.stringify({ written });
    assert.equal(stub, `${AUDIT_STUB}${LISTS}${whole.slice(0, 1000)} [cut at the inline cap: 1000 of these fields' ` +
      `${whole.length} characters; the whole result is where this note says]`);
  } finally { await h.framework.stop(); }
});

test('#277: direct API: a withheld result keeps its file lists, cut at the house default cap it was stored under', async () => {
  const h = await harness([], { toolResultGuard: true });
  const responses: unknown[] = [calls('marked'), refused(), answer()];
  (h.membrane as unknown as { stream: () => Promise<unknown> }).stream = async () => {
    const response = responses.shift();
    assert.ok(response);
    return response;
  };
  try {
    const agent = h.framework.getAgent('assistant')!;
    agent.getContextManager().addMessage('user', [{ type: 'text', text: 'read' }]);
    await agent.runInference(h.framework.getAllTools());
    const written = Array.from({ length: 3000 }, (_, i) => `file-${i}.txt`);
    agent.provideToolResult('marked', { success: true, data: { written }, keepWhenWithheld: ['written'] });
    await agent.runInference(h.framework.getAllTools());
    const stub = String(toolResults(h.framework)[0].content);
    const whole = JSON.stringify({ written });
    assert.ok(whole.length > DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS);
    assert.equal(stub, `${AUDIT_STUB}${LISTS}${whole.slice(0, DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS)}` +
      ` [cut at the inline cap: ${DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS} of these fields' ${whole.length} characters; ` +
      'the whole result is where this note says]');
  } finally { await h.framework.stop(); }
});

test('#283: a withheld materialize keeps the deletions it made; sync keeps a root it accepted ahead of its results', async () => {
  const h = await workspaceHarness([[toolUse('m', 'workspace--materialize', { applyDeletions: true }), refused()], [answer()]]);
  const call = (name: string, input: Record<string, unknown> = {}) => h.workspace.handleToolCall({ id: name, name, input } as never);
  try {
    // A file on disk that the workspace then deletes: the agent's materialize removes it.
    assert.equal((await h.workspace.writeBinary('work/old.txt', Buffer.from('old'), 'text/plain')).success, true);
    assert.equal((await call('materialize')).success, true);
    assert.equal((await call('delete', { path: 'work/old.txt' })).success, true);
    await h.run();
    const [materialize] = toolResults(h.framework).map((block) => String(block.content));
    assert.deepEqual(keptLists(materialize), { deleted: [{ mount: 'work', path: 'old.txt' }], materialized: [] }, materialize);
    // sync marks a root it accepted first, so a long results list can't cut it away.
    const synced = await call('sync');
    assert.deepEqual(synced.keepWhenWithheld, ['rootsAccepted', 'results']);
  } finally { await h.framework.stop(); }
});

test('#277: withheld materialize, sync and delete keep the files they acted on in their stubs', async () => {
  const h = await workspaceHarness([
    [toolUse('m', 'workspace--materialize'), refused()], [answer()],
    [toolUse('s', 'workspace--sync'), refused()], [answer()],
    [toolUse('d', 'workspace--delete', { path: 'work/LOG.md' }), refused()], [answer()],
  ]);
  try {
    // A workspace draft disk doesn't have yet: the materialize writes it.
    assert.equal((await h.workspace.writeBinary('work/LOG.md', Buffer.from('log'), 'text/plain')).success, true);
    await h.run();
    // A file disk has and the workspace doesn't: the sync takes it in.
    const mountDir = /^(.*)\/LOG\.md$/.exec(h.workspace.resolveAbsolutePath('work/LOG.md')!)![1];
    writeFileSync(join(mountDir, 'disk.txt'), 'from disk');
    await h.run();
    await h.run();
    const [materialize, sync, del] = toolResults(h.framework).map((block) => String(block.content));
    assert.deepEqual(keptLists(materialize), { materialized: [{ mount: 'work', path: 'LOG.md' }] }, materialize);
    const synced = keptLists(sync) as { results: Array<{ mount: string; synced: string[] }> };
    assert.deepEqual(synced.results.map((r) => [r.mount, r.synced]), [['work', ['disk.txt']]], sync);
    assert.deepEqual(keptLists(del), { path: 'work/LOG.md', deleted: true }, del);
    for (const stub of [materialize, sync, del]) assert.match(stub, /^Tool result withheld by the guard\. The tool has already executed\. Its result is in workspace file /);
  } finally { await h.framework.stop(); }
});

test('an unexpected annotation exception releases its compression hold', async () => {
  const r = await compressionRig();
  const branch = r.cm.currentBranch.bind(r.cm);
  try {
    r.guard.abandon('test');
    r.cm.currentBranch = () => { throw new Error('injected annotation branch read'); };
    await r.guard.whenAnnotated();
    r.cm.currentBranch = branch;
    assert.equal(r.cm.getCompressionHolds().size, 0);
    assert.equal(r.cm.getMessage(r.messageId!)!.content[0].type, 'tool_result');
    assert.equal((r.cm.getMessage(r.messageId!)!.content[0] as { content: string }).content, TOOL_RESULT_GUARD_NOTICE);
  } finally { r.cm.currentBranch = branch; await r.cm.close(); }
});

test('a throw after treeSet reports the original as readable', async () => {
  const h = await workspaceHarness([], { autoMaterialize: true });
  const ws = h.workspace as unknown as { pushUnlocked: () => Promise<never> };
  const push = ws.pushUnlocked;
  try {
    ws.pushUnlocked = async () => { throw new Error('injected push exception'); };
    const result = await h.workspace.writeBinary('work/throw.txt', Buffer.from('original'), 'text/plain');
    assert.equal(result.success, false);
    assert.equal((result.data as { inChronicle?: boolean })?.inChronicle, true);
    assert.match(result.error!, /injected push exception/);
    const file = await h.workspace.readBinary('work/throw.txt');
    assert.ok('data' in file);
    assert.equal(file.data.toString(), 'original');
  } finally { ws.pushUnlocked = push; await h.framework.stop(); }
});

test('a throw from recording the intent after treeSet still reports the original as readable', async () => {
  const h = await workspaceHarness([]);
  const ws = h.workspace as unknown as { intents: Map<string, { update: (...args: unknown[]) => unknown }> };
  const intents = ws.intents.get('work')!;
  const update = intents.update;
  try {
    intents.update = () => { throw new Error('injected intent exception'); };
    const result = await h.workspace.writeBinary('work/intent.txt', Buffer.from('original'), 'text/plain');
    assert.equal(result.success, false);
    assert.equal((result.data as { inChronicle?: boolean })?.inChronicle, true);
    assert.match(result.error!, /Stored "work\/intent\.txt" in Chronicle, but the rest of the write failed: injected intent exception/);
    const file = await h.workspace.readBinary('work/intent.txt');
    assert.ok('data' in file);
  } finally { intents.update = update; await h.framework.stop(); }
});

test("the reference fetcher's writer takes a file the tree holds as saved", async () => {
  const h = await workspaceHarness([], { autoMaterialize: true });
  const ws = h.workspace as unknown as { pushUnlocked: () => Promise<never> };
  const push = ws.pushUnlocked;
  const f = h.framework as unknown as { getReferenceFetcher(): { saveFile: (name: string, data: Buffer, mime: string) => Promise<string | null> } };
  try {
    ws.pushUnlocked = async () => { throw new Error('injected push exception'); };
    const saved = await f.getReferenceFetcher().saveFile('ref.txt', Buffer.from('fetched'), 'text/plain');
    assert.equal(saved, 'work/refs/ref.txt', 'stored in the tree, so the reference names it');
  } finally { ws.pushUnlocked = push; await h.framework.stop(); }
});

test("an inline spill's failed disk copy is traced with its error, cut at 200 characters, or a fallback", async () => {
  const h = await workspaceHarness([]);
  const traces: Array<{ type: string; error?: string }> = [];
  h.framework.onTrace((e) => traces.push(e as never));
  const f = h.framework as unknown as { writeToolResultFile(label: string, text: string, branch: string): Promise<unknown> };
  const original = h.workspace.writeBinary.bind(h.workspace);
  try {
    for (const error of ['x'.repeat(300), undefined]) {
      h.workspace.writeBinary = async () => ({ success: false, isError: true, ...(error ? { error } : {}), data: { inChronicle: true } });
      await f.writeToolResultFile(`label-${error ? 'long' : 'none'}`, 'content', h.framework.getStore().currentBranch().name);
      const traced = traces.filter((t) => t.type === 'tool:spill_failed').at(-1);
      assert.ok(traced, 'traced');
      assert.equal(traced!.error, error ? 'x'.repeat(200) : 'the rest of the write failed');
    }
  } finally { h.workspace.writeBinary = original; await h.framework.stop(); }
});

test('a batch that used its deadline is logged once for the batch, by the guard', async (t) => {
  const h = await workspaceHarness([[calls('one', 'two', 'three'), refused()], [answer()]]);
  (h.framework as unknown as { spillWithheld: () => Promise<unknown> }).spillWithheld = async () => ({ skipped: 'batch_deadline' });
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  try {
    await bounded(h.run(), 'the run');
    await h.framework.getAgent('assistant')!.toolResultGuard.whenAnnotated();
    assert.equal(lines.filter((line) => /used its deadline/.test(line)).length, 1, lines.join('\n'));
  } finally { await h.framework.stop(); }
});

test('a withheld spill with no finite deadline takes its own, not a 1 ms timer', async () => {
  const h = await workspaceHarness([]);
  const f = h.framework as unknown as {
    writeToolResultFile: () => Promise<unknown>;
    spillWithheld: (label: string, text: string, branch: string, deadline: number) => Promise<unknown>;
    stalledSpills: Set<unknown>;
  };
  f.writeToolResultFile = async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { path: 'work/tool-results/slow.txt' }; };
  try {
    const spilled = await f.spillWithheld('slow', 'original', h.framework.getStore().currentBranch().name, Infinity);
    assert.deepEqual(spilled, { path: 'work/tool-results/slow.txt' }, 'a 20 ms write finishes within the default deadline');
    assert.equal(f.stalledSpills.size, 0);
  } finally { await h.framework.stop(); }
});

test("a batch's deadline is taken when it is queued, not when the batches ahead of it finish", async () => {
  const r = await compressionRig();
  try {
    const first = gate();
    let entered = 0;
    let taken = 0;
    r.guard.setHost({
      deadline: () => { taken++; return Date.now() + 60_000; },
      spill: async () => { entered++; if (entered === 1) await first.opened; return null; },
      track: () => {}, idle: () => {},
    });
    r.guard.submissionResults([{ toolUseId: 'tu-1', content: r.REAL }]);
    assert.ok(r.guard.withhold('test-category'));
    await until(() => entered === 1, 'the first annotation is writing');
    // A second batch queued behind the first, still writing.
    r.cm.addMessage('Claude', [{ type: 'tool_use', id: 'tu-2', name: 'search', input: {} }]);
    r.guard.storeResults([{ type: 'tool_result', toolUseId: 'tu-2', content: 'SECOND' }],
      [{ toolUseId: 'tu-2', content: 'SECOND' }], [], undefined, undefined);
    r.guard.submissionResults([{ toolUseId: 'tu-2', content: 'SECOND' }]);
    assert.ok(r.guard.withhold('test-category'));
    assert.equal(taken, 2, "the second batch's deadline was taken when it was queued");
    first.open();
    await bounded(r.guard.whenAnnotated(), 'both annotations');
    assert.equal(taken, 2, 'and not taken again when its annotation ran');
  } finally { r.cm.close(); }
});

test('a throw before treeSet does not claim a readable original', async () => {
  const h = await workspaceHarness([]);
  const store = h.framework.getStore();
  const set = store.treeSet.bind(store);
  try {
    store.treeSet = () => { throw new Error('injected tree exception'); };
    await assert.rejects(h.workspace.writeBinary('work/throw.txt', Buffer.from('original'), 'text/plain'), /injected tree exception/);
    assert.equal(store.treeGet('workspace/work/tree', 'throw.txt'), null);
  } finally { store.treeSet = set; await h.framework.stop(); }
});

test('abort during the direct refusal retry annotation sends no retry', async () => {
  const h = await harness([], { toolResultGuard: true });
  const requests: NormalizedRequest[] = [];
  const responses = [calls('one'), refused(), answer()];
  (h.membrane as unknown as { stream: (r: NormalizedRequest) => Promise<NormalizedResponse> }).stream = async (r) => {
    requests.push(r); return responses.shift()!;
  };
  const write = gate();
  let entered = false;
  slowSpill(h.framework, () => { entered = true; return write.opened; });
  try {
    const agent = h.framework.getAgent('assistant')!;
    await agent.runInference([]);
    agent.provideToolResult('one', { success: true, data: 'original' });
    const controller = new AbortController();
    const inference = agent.runInference([], undefined, { signal: controller.signal });
    await until(() => entered, 'the direct retry waits for annotation');
    controller.abort();
    write.open();
    const result = await inference;
    assert.equal(requests.length, 2);
    assert.equal(result.aborted, true);
    assert.equal(String(agent.state.status), 'idle');
  } finally { write.open(); await h.framework.stop(); }
});

test('unguarded results are read after the direct compile', async () => {
  const h = await harness([]);
  const agent = h.framework.getAgent('assistant')!;
  const compile = agent.compileWithInjections.bind(agent);
  const requests: NormalizedRequest[] = [];
  (h.membrane as unknown as { stream: (r: NormalizedRequest) => Promise<NormalizedResponse> }).stream = async (r) => {
    requests.push(r); return answer();
  };
  agent.compileWithInjections = async (...args) => {
    const result = await compile(...args);
    // A tool result becoming ready in the compile's await must be observed,
    // as it was before annotations added another await around compilation.
    agent.enterWaitingForTools([{ id: 'late', name: 'test--read', input: {} }], new MockYieldingStream([]));
    agent.provideToolResult('late', { success: true, data: 'arrived-during-compile' });
    return result;
  };
  try {
    await agent.runInference([]);
    assert.match(JSON.stringify(requests[0]), /arrived-during-compile/);
  } finally { await h.framework.stop(); }
});

test('stop then start reopens withheld spills', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-restart-')); dirs.push(dir);
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  const framework = await AgentFramework.create({ store, membrane: new ScriptMembrane([]).asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system', toolResultGuard: true }],
    modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0 });
  const f = framework as unknown as {
    toolResultFilePlace: () => unknown;
    writeToolResultFile: () => Promise<unknown>;
  };
  f.toolResultFilePlace = () => ({ path: 'work/original.txt', safeLabel: 'original' });
  let writes = 0;
  f.writeToolResultFile = async () => { writes++; return { path: 'work/original.txt' }; };
  try {
    framework.start();
    await framework.stop();
    framework.start();
    const guard = framework.getAgent('assistant')!.toolResultGuard;
    guard.storeResults([{ type: 'tool_result', toolUseId: 'one', content: 'original' }],
      [{ toolUseId: 'one', content: 'original' }], [], undefined, undefined);
    guard.abandon('test');
    await guard.whenAnnotated();
    assert.equal(writes, 1);
    assert.match(String(toolResults(framework)[0].content), /is in workspace file work\/original.txt/);
  } finally { await framework.stop(); store.close(); }
});

test('a framework compile from before stop cannot drive after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-generation-')); dirs.push(dir);
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  // One scripted answer for the turn compiled before the stop, one for the turn begun after the restart.
  const membrane = new ScriptMembrane([[answer()], [answer()]]);
  const framework = await AgentFramework.create({ store, membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system' }],
    modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0 });
  const agent = framework.getAgent('assistant')!;
  const compile = gate();
  const entered = gate();
  const build = agent.buildActivationRequest.bind(agent);
  agent.buildActivationRequest = async (...args) => { entered.open(); await compile.opened; return build(...args); };
  let driven = 0;
  const stream = membrane.streamYielding.bind(membrane);
  membrane.streamYielding = (...args) => {
    const result = stream(...args);
    const iterate = result[Symbol.asyncIterator].bind(result);
    result[Symbol.asyncIterator] = () => { driven++; return iterate(); };
    return result;
  };
  let starting: Promise<void> | undefined;
  // The dropped turn's inference:* events, as a module's trace listener sees them.
  const turnEvents: Array<{ type: string; reason?: string }> = [];
  const unsubscribe = framework.onTrace((event) => {
    if (event.type.startsWith('inference:') && (event as { agentName?: string }).agentName === 'assistant') {
      turnEvents.push({ type: event.type, ...('reason' in event ? { reason: String(event.reason) } : {}) });
    }
  });
  try {
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      starting = (framework as unknown as { startAgentStream(a: typeof agent): Promise<void> }).startAgentStream(agent);
      await entered.opened;
      await framework.stop();
      framework.start();
      compile.open();
      await starting;
    } finally { console.error = error; }
    assert.equal(driven, 0);
    assert.ok(lines.some((line) => /stopped and started again/.test(line) && /dropped before it sends anything/.test(line)), lines.join('\n'));
    // The turn emitted inference:started before its compile, so it gets one
    // terminal event: a listener's bracket (a typing loop) closes.
    assert.deepEqual(turnEvents.map((event) => event.type), ['inference:started', 'inference:aborted']);
    assert.match(turnEvents[1]?.reason ?? '', /stopped and started again.*dropped before it sends anything/);
    unsubscribe();
    // A turn begun after the restart is admitted and drives its stream.
    await (framework as unknown as { startAgentStream(a: typeof agent): Promise<void> }).startAgentStream(agent);
    await until(() => driven === 1, 'the turn begun after the restart drives');
  } finally { compile.open(); await starting; await framework.stop(); store.close(); }
});

// A turn dropped before it sends anything, at either check: before its
// compile (it waits in a module's gatherContext) or after it (it waits in its
// compile). Each way it can lose its place: the framework stops, the agent is
// removed, the agent object is replaced under its name, or the replacement's
// own turn already holds the name's turn token.
for (const phase of ['before', 'after'] as const) {
  for (const how of ['stopping', 'removed', 'disposed', 'replaced', 'superseded'] as const) {
    const title = { stopping: 'the framework stopping', removed: 'its agent removed',
      disposed: 'its run disposed with its record', replaced: 'its agent replaced',
      superseded: "a newer turn of its agent's name running" }[how];
    test(`a turn dropped ${phase} its compile, with ${title}, ${how === 'superseded' ? "leaves the newer turn's bracket alone" : 'ends with inference:aborted'}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `guard-drop-${phase}-compile-`)); dirs.push(dir);
      const store = JsStore.openOrCreate({ path: join(dir, 'store') });
      const membrane = new ScriptMembrane([[answer()]]);
      const framework = await AgentFramework.create({ store, membrane: membrane.asMembrane(),
        agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system' }],
        modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0 });
      const agent = framework.getAgent('assistant')!;
      const internal = framework as unknown as {
        moduleRegistry: { gatherContext: (n: string) => Promise<unknown[]> };
        agents: Map<string, unknown>;
        activeTurnTokens: Map<string, number>;
        lastInferenceAt: Map<string, { startedAt?: number; endedAt?: number }>;
      };
      const held = gate();
      const entered = gate();
      if (phase === 'before') {
        internal.moduleRegistry.gatherContext = async () => { entered.open(); await held.opened; return []; };
      } else {
        const build = agent.buildActivationRequest.bind(agent);
        agent.buildActivationRequest = async (...args) => { entered.open(); await held.opened; return build(...args); };
      }
      const turnEvents: Array<{ type: string; reason?: string; durationMs?: number }> = [];
      framework.onTrace((event) => {
        if (event.type.startsWith('inference:') && (event as { agentName?: string }).agentName === 'assistant') {
          turnEvents.push({ type: event.type,
            ...('reason' in event ? { reason: String(event.reason) } : {}),
            ...('durationMs' in event ? { durationMs: Number(event.durationMs) } : {}) });
        }
      });
      const lines: string[] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
      const heldMs = 25;
      let starting: Promise<unknown> | undefined;
      try {
        starting = (framework as unknown as { startAgentStream(a: typeof agent): Promise<unknown> }).startAgentStream(agent);
        await entered.opened;
        if (how === 'stopping') await framework.stop();
        else if (how === 'removed') internal.agents.delete('assistant');
        else if (how === 'disposed') {
          // As runEphemeralToCompletion's disposal does: the agent, its record and its token go.
          internal.agents.delete('assistant');
          internal.lastInferenceAt.delete('assistant');
          internal.activeTurnTokens.delete('assistant');
        } else {
          internal.agents.set('assistant', Object.create(agent));
          if (how === 'superseded') internal.activeTurnTokens.set('assistant', -1);
        }
        await new Promise((resolve) => setTimeout(resolve, heldMs));
        held.open();
        await starting;
      } finally { console.error = error; held.open(); await starting; }
      try {
        const why = how === 'stopping' ? 'the framework was stopping' : 'the agent was replaced or removed';
        const reason = `a turn ${phase === 'before' ? 'assembled' : 'compiled'} while ${why} is dropped before it sends anything`;
        assert.ok(lines.some((line) => line.includes(reason)), lines.join('\n'));
        const last = internal.lastInferenceAt.get('assistant');
        if (how === 'superseded') {
          // The terminal event and lastInference carry only the name, so they
          // would end the newer turn: the dropped frame emits and records nothing.
          assert.deepEqual(turnEvents.map((event) => event.type), ['inference:started']);
          assert.equal(last?.endedAt, undefined);
        } else {
          assert.deepEqual(turnEvents.map((event) => event.type), ['inference:started', 'inference:aborted']);
          assert.equal(turnEvents[1]?.reason, reason);
          const durationMs = turnEvents[1]?.durationMs ?? NaN;
          assert.ok(Number.isFinite(durationMs) && durationMs >= heldMs - 5 && durationMs < 60_000, `durationMs ${durationMs}`);
          if (how === 'disposed') {
            // The terminal event still closes a listener's bracket, but the
            // disposed name gets no record back.
            assert.equal(internal.lastInferenceAt.has('assistant'), false, JSON.stringify(last));
          } else {
            assert.ok(last?.endedAt !== undefined && last.endedAt >= (last.startedAt ?? Infinity), JSON.stringify(last));
          }
        }
      } finally {
        if (how === 'superseded') internal.activeTurnTokens.delete('assistant');
        if (how !== 'stopping') internal.agents.set('assistant', agent);
        await framework.stop(); store.close();
      }
    });
  }
}

// Drain async storage/annotation continuations without advancing deadline time.
async function flushAsync() {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('slow successful writes share one batch deadline', async (t) => {
  const h = await workspaceHarness([]);
  const f = h.framework as unknown as {
    withheldSpillDeadlineMs: number;
    writeToolResultFile: (label: string) => Promise<{ path: string }>;
  };
  f.withheldSpillDeadlineMs = 50;
  const writes: string[] = [];
  const first = gate();
  const second = gate();
  f.writeToolResultFile = async (label) => {
    writes.push(label);
    await (writes.length === 1 ? first.opened : second.opened);
    return { path: `work/tool-results/${label}.txt` };
  };
  const guard = h.framework.getAgent('assistant')!.toolResultGuard;
  try {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    guard.storeResults(['one', 'two', 'three'].map((id) => ({ type: 'tool_result', toolUseId: id, content: id })),
      ['one', 'two', 'three'].map((id) => ({ toolUseId: id, content: id })), [], undefined, undefined);
    guard.abandon('test');
    let annotated = false;
    void guard.whenAnnotated().then(() => { annotated = true; });
    await flushAsync();
    assert.equal(writes.length, 1);
    t.mock.timers.tick(30);
    first.open();
    await flushAsync();
    assert.equal(writes.length, 2);
    t.mock.timers.tick(19);
    await flushAsync();
    assert.equal(annotated, false);
    t.mock.timers.tick(1);
    await flushAsync();
    assert.equal(annotated, true, 'the second write has only the remaining 20 ms');
    assert.equal(writes.length, 2, 'the third original stays in audit');
    const notices = toolResults(h.framework).map((b) => String(b.content));
    assert.match(notices[0], /is in workspace file/);
    assert.match(notices[1], /was still being written/);
    assert.equal(notices[2], AUDIT_STUB);
  } finally { first.open(); second.open(); t.mock.timers.reset(); await h.framework.stop(); }
});

test('a withheld deadline and an unanswered skip are observable', async (t) => {
  const h = await workspaceHarness([]);
  const f = h.framework as unknown as {
    withheldSpillDeadlineMs: number;
    writeToolResultFile: () => Promise<null>;
    spillWithheld: (label: string, text: string, branch: string) => Promise<unknown>;
  };
  f.withheldSpillDeadlineMs = 50;
  const write = gate();
  f.writeToolResultFile = async () => { await write.opened; return null; };
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  try {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const spilling = f.spillWithheld('stalled', 'original', h.framework.getStore().currentBranch().name);
    let settled = false;
    void spilling.then(() => { settled = true; });
    t.mock.timers.tick(49);
    await flushAsync();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await flushAsync();
    assert.equal(settled, true, 'the configured 50 ms, not a multi-second ceiling');
    assert.deepEqual(await spilling, { path: 'work/tool-results/stalled.txt', unfinished: true });
    for (const label of ['skipped-1', 'skipped-2', 'skipped-3']) {
      assert.deepEqual(await f.spillWithheld(label, 'original', h.framework.getStore().currentBranch().name), { skipped: 'workspace_unanswered' });
    }
    assert.ok(logs.some((line) => /still being written/.test(line) && /deadline/.test(line)), logs.join('\n'));
    // One line for the stall's skips, not one per skipped result.
    assert.equal(logs.filter((line) => /workspace_unanswered/.test(line)).length, 1, logs.join('\n'));
    write.open();
    t.mock.timers.reset();
    await until(() => logs.some((line) => /answered again; 3 withheld original\(s\) were skipped/.test(line)), 'the count when the stall clears');
  } finally { write.open(); t.mock.timers.reset(); await h.framework.stop(); }
});

test('an exhausted batch starts no new write without claiming a stalled workspace', async () => {
  const h = await workspaceHarness([]);
  const f = h.framework as unknown as {
    spillWithheld(label: string, text: string, branch: string, deadline: number): Promise<unknown>;
    writeToolResultFile(): Promise<null>;
  };
  let writes = 0;
  f.writeToolResultFile = async () => { writes++; return null; };
  try {
    assert.deepEqual(await f.spillWithheld('expired', 'original', h.framework.getStore().currentBranch().name, Date.now() - 1),
      { skipped: 'batch_deadline' });
    assert.equal(writes, 0);
  } finally { await h.framework.stop(); }
});

test('an inline spill names the readable tree file and traces its failed disk copy', async () => {
  const h = await workspaceHarness([], { autoMaterialize: true });
  writeFileSync(join(h.mountDir, 'tool-results'), 'not a directory');
  const traces: Array<{ type: string; path?: string }> = [];
  h.framework.onTrace((event) => traces.push(event as { type: string; path?: string }));
  try {
    const f = h.framework as unknown as {
      spillOrTruncate(text: string, cap: number, label: string): Promise<{ text: string; filePath: string | null }>;
    };
    const result = await f.spillOrTruncate('original'.repeat(30), 20, 'inline');
    assert.equal(result.filePath, 'work/tool-results/inline.txt');
    assert.match(result.text, /work\/tool-results\/inline.txt/);
    const file = await h.workspace.readBinary(result.filePath!);
    assert.ok('data' in file);
    assert.equal(file.data.toString(), 'original'.repeat(30));
    assert.ok(traces.some((t) => t.type === 'tool:spill_failed' && t.path === result.filePath));
  } finally { await h.framework.stop(); }
});

test('an already-aborted direct call never reaches membrane', async () => {
  const h = await harness([]);
  let calls = 0;
  (h.membrane as unknown as { stream: () => Promise<NormalizedResponse> }).stream = async () => { calls++; return answer(); };
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await h.framework.getAgent('assistant')!.runInference([], undefined, { signal: controller.signal });
    assert.equal(result.aborted, true);
    assert.equal(calls, 0);
  } finally { await h.framework.stop(); }
});

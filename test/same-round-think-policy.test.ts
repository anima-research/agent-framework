import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import type {
  ContentBlock,
  NormalizedRequest,
  NormalizedResponse,
  YieldingStream,
  StreamEvent,
} from '@animalabs/membrane';

const TILDE_PREFACE_80 = 'P'.repeat(80);
const TILDE_THINK_4416 = 'T'.repeat(4416);

class TestToolsModule implements Module {
  readonly name = 'tools';

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'read',
        description: 'Read from the workspace.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      {
        name: 'ping',
        description: 'A non-silencing tool.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'think',
        description: 'A namespaced tool that happens to be called think.',
        inputSchema: { type: 'object', properties: { content: { type: 'string' } } },
      },
      {
        name: 'send_message',
        description: 'Explicitly send a message.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return { success: true, data: { ok: true, tool: call.name, input: call.input } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const text = String((event as { content?: unknown }).content ?? '');
    return {
      addMessages: [{ participant: 'Antra', content: [{ type: 'text', text }] }],
      requestInference: text === 'go',
    };
  }
}

function makeToolRound(preface: string): ContentBlock[] {
  return [
    { type: 'text', text: preface },
    { type: 'tool_use', id: 'think-1', name: 'think', input: { content: TILDE_THINK_4416 } },
    { type: 'tool_use', id: 'read-1', name: 'tools--read', input: { path: 'project/secret.txt' } },
  ] as ContentBlock[];
}

function makeChannelRegistry(framework: AgentFramework) {
  const routed: string[] = [];
  const explicit = {
    getChannelTools: () => [
      {
        name: 'think',
        description: 'private reasoning',
        inputSchema: {
          type: 'object' as const,
          properties: { content: { type: 'string' } },
          required: [],
        },
      },
      {
        name: 'skip_reply',
        description: 'stay silent',
        inputSchema: {
          type: 'object' as const,
          properties: { reason: { type: 'string' } },
          required: [],
        },
      },
    ],
    handleChannelToolCall: async (toolName: string) => {
      if (toolName === 'think') {
        return {
          success: true,
          data: {
            noted: true,
            note:
              'Thought recorded (private — not sent anywhere). Same-round text routing depends on your current same_round_think_text_policy; use agent_settings get to inspect it, or call skip_reply to end the turn without replying.',
          },
        };
      }
      if (toolName === 'skip_reply') {
        return {
          success: true,
          endTurn: true,
          data: { skipped: true, note: 'Turn ended; nothing sent.' },
        };
      }
      return { success: false, error: `Unknown channel tool: ${toolName}`, isError: true };
    },
    resolveLocus: () => 'chan-test',
    routeSpeech: async (_agent: string, text: string) => {
      routed.push(text);
    },
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop as keyof typeof target] : () => undefined),
  });
  return routed;
}

async function createFramework(opts?: {
  policy?: 'public' | 'private';
  membrane?: { asMembrane?: () => unknown } | unknown;
  agents?: Array<{ name: string; sameRoundThinkTextPolicy?: 'public' | 'private' }>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'same-round-think-'));
  const membrane = opts?.membrane ?? new MockMembrane();
  const agents = opts?.agents ?? [{
    name: 'agent',
    ...(opts?.policy !== undefined ? { sameRoundThinkTextPolicy: opts.policy } : {}),
  }];
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: ((membrane as { asMembrane?: () => unknown }).asMembrane?.() ?? membrane) as import('@animalabs/membrane').Membrane,
    agents: agents.map((agent) => ({
      name: agent.name,
      model: 'test-model',
      systemPrompt: 'test',
      ...(agent.sameRoundThinkTextPolicy !== undefined
        ? { sameRoundThinkTextPolicy: agent.sameRoundThinkTextPolicy }
        : {}),
    })),
    modules: [new TestToolsModule()],
  });
  const routed = makeChannelRegistry(framework);
  return { dir, framework, membrane, routed };
}

function trigger(framework: AgentFramework): void {
  framework.pushEvent({
    type: 'external-message',
    source: 'test',
    channelId: 'test:channel',
    content: 'go',
    metadata: {},
  } as unknown as ProcessEvent);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

class LegacyNoRoundContentStream {
  private pendingResolve: (() => void) | null = null;
  private deliveredComplete = false;

  provideToolResults(_results: unknown[]): void {
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    resolve?.();
  }

  cancel(): void {
    this.deliveredComplete = true;
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    resolve?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield {
      type: 'tool-calls',
      calls: [
        { id: 'think-legacy', name: 'think', input: { content: TILDE_THINK_4416 } },
        { id: 'read-legacy', name: 'tools--read', input: { path: 'project/secret.txt' } },
      ],
      context: {
        rawText: '',
        preamble: TILDE_PREFACE_80,
        depth: 0,
        previousResults: [],
        accumulated: '',
      },
    } as StreamEvent;
    await new Promise<void>((resolve) => { this.pendingResolve = resolve; });
    if (this.deliveredComplete) return;
    yield {
      type: 'complete',
      response: createMockResponse(makeToolRound(TILDE_PREFACE_80)),
    } as StreamEvent;
  }
}

class LegacyNoRoundContentMembrane {
  calls: NormalizedRequest[] = [];

  streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    return new LegacyNoRoundContentStream() as unknown as YieldingStream;
  }
}

class PausedAfterFirstToolRoundStream implements YieldingStream {
  private events: StreamEvent[] = [];
  private done = false;
  private _isWaitingForTools = false;
  private _pendingToolCallIds: string[] = [];
  private _toolDepth = 0;
  private pendingResolve: (() => void) | null = null;
  private paused = false;
  receivedToolResults: unknown[][] = [];
  receivedToolResultOptions: Array<
    { injectedMessages?: Array<{ participant?: string; content: unknown[] }> } | undefined
  > = [];

  constructor(private readonly responses: NormalizedResponse[]) {
    this.processResponse(0);
  }

  private processResponse(index: number): void {
    const response = this.responses[index];
    if (!response) {
      this.done = true;
      return;
    }

    if (response.rawAssistantText) {
      this.events.push({
        type: 'block',
        event: { event: 'block_start', index: 0, block: { type: 'text' } },
      } as StreamEvent);
      this.events.push({
        type: 'tokens',
        content: response.rawAssistantText,
        meta: { type: 'text', visible: true, blockIndex: 0 },
      } as StreamEvent);
      this.events.push({
        type: 'block',
        event: { event: 'block_complete', index: 0, block: { type: 'text', content: response.rawAssistantText } },
      } as StreamEvent);
    }

    if (response.usage) {
      this.events.push({ type: 'usage', usage: response.usage } as StreamEvent);
    }

    if (response.toolCalls.length > 0) {
      this._isWaitingForTools = true;
      this._pendingToolCallIds = response.toolCalls.map((tc) => tc.id);
      this.events.push({
        type: 'tool-calls',
        calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input as Record<string, unknown>,
        })),
        context: {
          rawText: '',
          preamble: '',
          depth: this._toolDepth,
          previousResults: [],
          accumulated: '',
          roundContent: response.content,
        },
      } as StreamEvent);
      return;
    }

    this.events.push({ type: 'complete', response } as StreamEvent);
    this.done = true;
  }

  provideToolResults(
    results: unknown[],
    options?: { injectedMessages?: Array<{ participant?: string; content: unknown[] }> },
  ): void {
    if (!this._isWaitingForTools) throw new Error('Not waiting for tools');
    this.receivedToolResults.push(results);
    this.receivedToolResultOptions.push(options);
    this._isWaitingForTools = false;
    this._pendingToolCallIds = [];
    this._toolDepth++;
    if (this._toolDepth === 1) {
      this.paused = true;
      return;
    }
    this.processResponse(this._toolDepth);
    this.pendingResolve?.();
    this.pendingResolve = null;
  }

  release(): void {
    if (!this.paused) return;
    this.paused = false;
    this.processResponse(this._toolDepth);
    this.pendingResolve?.();
    this.pendingResolve = null;
  }

  cancel(): void {
    this.done = true;
    this._pendingToolCallIds = [];
    this.pendingResolve?.();
    this.pendingResolve = null;
  }

  get isWaitingForTools() {
    return this._isWaitingForTools;
  }

  get pendingToolCallIds() {
    return [...this._pendingToolCallIds];
  }

  get toolDepth() {
    return this._toolDepth;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    while (true) {
      while (this.events.length > 0) {
        const event = this.events.shift()!;
        yield event;
        if (event.type === 'complete' || event.type === 'error' || event.type === 'aborted') {
          return;
        }
      }
      if (this.done) return;
      await new Promise<void>((resolve) => { this.pendingResolve = resolve; });
    }
  }
}

class ScenarioMembrane {
  calls: NormalizedRequest[] = [];
  lastStream: PausedAfterFirstToolRoundStream | MockYieldingStream | null = null;
  private scenarios: Array<{ responses: NormalizedResponse[]; pauseAfterFirstToolRound?: boolean }> = [];

  queueScenario(
    responses: NormalizedResponse[],
    opts?: { pauseAfterFirstToolRound?: boolean },
  ): void {
    this.scenarios.push({ responses, pauseAfterFirstToolRound: opts?.pauseAfterFirstToolRound });
  }

  streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const next = this.scenarios.shift();
    if (!next) throw new Error('No queued stream scenario');
    const stream = next.pauseAfterFirstToolRound
      ? new PausedAfterFirstToolRoundStream(next.responses)
      : new MockYieldingStream(next.responses);
    this.lastStream = stream;
    return stream as unknown as YieldingStream;
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

function thinkDescription(request: NormalizedRequest): string {
  const thinkTool = (request.tools ?? []).find((tool) => tool.name === 'think');
  assert.ok(thinkTool, 'think tool should be present');
  return thinkTool.description;
}

async function expectInFlightResetRestoresNextInferencePolicy(opts: {
  basePolicy?: 'public' | 'private';
  resetInput: Record<string, unknown>;
}): Promise<void> {
  const membrane = new ScenarioMembrane();
  membrane.queueScenario([
    createMockResponse([
      { type: 'text', text: 'private request before reset' },
      { type: 'tool_use', id: 'think-1', name: 'think', input: { content: TILDE_THINK_4416 } },
      {
        type: 'tool_use',
        id: 'settings-1',
        name: 'agent_settings',
        input: opts.resetInput,
      },
      { type: 'tool_use', id: 'read-1', name: 'tools--read', input: { path: 'project/secret.txt' } },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([
      { type: 'text', text: 'still private in the continuation' },
      { type: 'tool_use', id: 'think-2', name: 'think', input: { content: TILDE_THINK_4416 } },
      { type: 'tool_use', id: 'ping-1', name: 'tools--ping', input: {} },
    ] as ContentBlock[], 'tool_use'),
    createMockResponse([] as ContentBlock[]),
  ], { pauseAfterFirstToolRound: true });
  membrane.queueScenario([
    createMockResponse(makeToolRound('public on the next inference'), 'tool_use'),
    createMockResponse([] as ContentBlock[]),
  ]);
  const { dir, framework, routed } = await createFramework({
    ...(opts.basePolicy !== undefined ? { policy: opts.basePolicy } : {}),
    membrane,
  });
  try {
    framework.updateAgentRuntimeSettings('agent', { sameRoundThinkTextPolicy: 'private' });
    assert.equal(
      framework.getAgentRuntimeSettings('agent').sameRoundThinkTextPolicy,
      'private',
    );

    framework.start();
    trigger(framework);
    await waitFor(() => membrane.calls.length === 1);
    await waitFor(() => (membrane.lastStream as PausedAfterFirstToolRoundStream | null)?.receivedToolResults.length === 1);

    const firstRoundResults = (membrane.lastStream as PausedAfterFirstToolRoundStream).receivedToolResults[0] as Array<{
      toolUseId: string;
      content: string;
    }>;
    const settingsResult = firstRoundResults.find((result) => result.toolUseId === 'settings-1');
    assert.ok(settingsResult, 'agent_settings reset result should be present');
    assert.match(settingsResult.content, /sameRoundThinkTextPolicyUpdateNote/);
    assert.match(settingsResult.content, /next inference/);

    assert.match(thinkDescription(membrane.calls[0]), /withheld from channel routing/);
    assert.deepEqual(routed, []);
    assert.equal(
      framework.getAgentRuntimeSettings('agent').sameRoundThinkTextPolicy,
      'public',
    );
    assert.match(
      thinkDescription(await framework.previewActivation('agent')),
      /may still be routed publicly as your speech/,
    );

    (membrane.lastStream as PausedAfterFirstToolRoundStream).release();
    await waitFor(() => (framework as unknown as { activeStreams: Map<string, Promise<void>> }).activeStreams.size === 0);
    assert.deepEqual(routed, []);

    trigger(framework);
    await waitFor(() => membrane.calls.length === 2);
    await waitFor(() => routed.length === 1);
    assert.match(thinkDescription(membrane.calls[1]), /may still be routed publicly as your speech/);
    assert.deepEqual(routed, ['public on the next inference']);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('same-round think text policy', () => {
  it('compatibility default/public routes the exact Tilde-shaped same-round preface', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse(makeToolRound(TILDE_PREFACE_80), 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const { dir, framework, routed } = await createFramework({ membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, [TILDE_PREFACE_80]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recipe private routes zero same-round prose for the exact Tilde shape', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse(makeToolRound(TILDE_PREFACE_80), 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const { dir, framework, routed } = await createFramework({ policy: 'private', membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, []);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('private is non-sticky: later non-think rounds and trailing prose route normally', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse(makeToolRound(TILDE_PREFACE_80), 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'visible same turn after a non-think tool round' },
      { type: 'tool_use', id: 'ping-1', name: 'tools--ping', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'visible trailing prose after tool results' },
    ] as ContentBlock[]));
    const { dir, framework, routed } = await createFramework({ policy: 'private', membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, [
        'visible same turn after a non-think tool round',
        'visible trailing prose after tool results',
      ]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('public remains non-silencing across later rounds and trailing prose', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse(makeToolRound(TILDE_PREFACE_80), 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'still public in the next tool round' },
      { type: 'tool_use', id: 'ping-2', name: 'tools--ping', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'still public in trailing prose' },
    ] as ContentBlock[]));
    const { dir, framework, routed } = await createFramework({ policy: 'public', membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, [
        TILDE_PREFACE_80,
        'still public in the next tool round',
        'still public in trailing prose',
      ]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('think plus skip_reply remains silent under both policies', async () => {
    for (const policy of ['public', 'private'] as const) {
      const membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: TILDE_PREFACE_80 },
        { type: 'tool_use', id: `think-${policy}`, name: 'think', input: { content: TILDE_THINK_4416 } },
        { type: 'tool_use', id: `skip-${policy}`, name: 'skip_reply', input: { reason: 'no reply' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([] as ContentBlock[]));
      const { dir, framework, routed } = await createFramework({ policy, membrane });
      try {
        trigger(framework);
        await framework.runUntilIdle();
        assert.deepEqual(routed, [], `${policy} should stay silent`);
      } finally {
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('explicit-send behavior is unchanged', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'sending directly' },
      { type: 'tool_use', id: 'send-1', name: 'tools--send_message', input: { text: 'hi' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'this later tool round should still stay silent' },
      { type: 'tool_use', id: 'ping-3', name: 'tools--ping', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'and trailing prose should stay silent too' },
    ] as ContentBlock[]));
    const { dir, framework, routed } = await createFramework({ policy: 'private', membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, []);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('private keeps the preface in Chronicle while withholding it from channel routing', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse(makeToolRound(TILDE_PREFACE_80), 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const { dir, framework, routed } = await createFramework({ policy: 'private', membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, []);
      const compiled = await framework.getAgent('agent')!.getContextManager().compile();
      assert.ok(
        compiled.messages.some((message) => JSON.stringify(message.content).includes(TILDE_PREFACE_80)),
        'the same-round preface should remain in Chronicle/context',
      );
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds different provider-bound think descriptions per agent, and preview matches activation', async () => {
    const { dir, framework } = await createFramework({
      agents: [
        { name: 'public-agent', sameRoundThinkTextPolicy: 'public' },
        { name: 'private-agent', sameRoundThinkTextPolicy: 'private' },
      ],
    });
    try {
      const previewPublic = await framework.previewActivation('public-agent');
      const previewPrivate = await framework.previewActivation('private-agent');
      const publicThink = previewPublic.tools?.find((tool) => tool.name === 'think');
      const privateThink = previewPrivate.tools?.find((tool) => tool.name === 'think');
      const staticThinkBefore = framework.getAllTools().find((tool) => tool.name === 'think');
      assert.ok(publicThink);
      assert.ok(privateThink);
      assert.ok(staticThinkBefore);
      assert.match(publicThink!.description, /may still be routed publicly as your speech/);
      assert.match(privateThink!.description, /withheld from channel routing/);
      assert.equal(staticThinkBefore!.description, 'private reasoning');

      const publicActivationTools = (framework as unknown as {
        getToolsForAgent: (agentName: string) => Array<{ name: string; description: string }>;
      }).getToolsForAgent('public-agent');
      const privateActivationTools = (framework as unknown as {
        getToolsForAgent: (agentName: string) => Array<{ name: string; description: string }>;
      }).getToolsForAgent('private-agent');
      assert.equal(
        publicActivationTools.find((tool) => tool.name === 'think')?.description,
        publicThink?.description,
      );
      assert.equal(
        privateActivationTools.find((tool) => tool.name === 'think')?.description,
        privateThink?.description,
      );
      assert.equal(
        framework.getAllTools().find((tool) => tool.name === 'think')?.description,
        'private reasoning',
      );
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a host update from public to private does not retroactively change an in-flight request snapshot', async () => {
    const membrane = new ScenarioMembrane();
    membrane.queueScenario([
      createMockResponse([
        { type: 'text', text: 'public snapshot round one' },
        { type: 'tool_use', id: 'think-1', name: 'think', input: { content: TILDE_THINK_4416 } },
        { type: 'tool_use', id: 'read-1', name: 'tools--read', input: { path: 'project/secret.txt' } },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'public snapshot round two' },
        { type: 'tool_use', id: 'think-2', name: 'think', input: { content: TILDE_THINK_4416 } },
        { type: 'tool_use', id: 'ping-1', name: 'tools--ping', input: {} },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([] as ContentBlock[]),
    ], { pauseAfterFirstToolRound: true });
    membrane.queueScenario([
      createMockResponse(makeToolRound('next inference should now be private'), 'tool_use'),
      createMockResponse([] as ContentBlock[]),
    ]);
    const { dir, framework, routed } = await createFramework({ policy: 'public', membrane });
    try {
      framework.start();
      trigger(framework);
      await waitFor(() => membrane.calls.length === 1);
      await waitFor(() => (membrane.lastStream as PausedAfterFirstToolRoundStream | null)?.receivedToolResults.length === 1);
      assert.match(thinkDescription(membrane.calls[0]), /may still be routed publicly as your speech/);
      assert.deepEqual(routed, ['public snapshot round one']);

      framework.updateAgentRuntimeSettings('agent', { sameRoundThinkTextPolicy: 'private' });
      const preview = await framework.previewActivation('agent');
      assert.match(thinkDescription(preview), /withheld from channel routing/);

      (membrane.lastStream as PausedAfterFirstToolRoundStream).release();
      await waitFor(() => routed.length === 2);
      assert.deepEqual(routed, [
        'public snapshot round one',
        'public snapshot round two',
      ]);

      trigger(framework);
      await waitFor(() => membrane.calls.length === 2);
      await waitFor(() => (framework as unknown as { activeStreams: Map<string, Promise<void>> }).activeStreams.size === 0);
      assert.match(thinkDescription(membrane.calls[1]), /withheld from channel routing/);
      assert.deepEqual(routed, [
        'public snapshot round one',
        'public snapshot round two',
      ]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a host update from private to public does not retroactively change an in-flight request snapshot', async () => {
    const membrane = new ScenarioMembrane();
    membrane.queueScenario([
      createMockResponse(makeToolRound('private snapshot round one'), 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'private snapshot round two' },
        { type: 'tool_use', id: 'think-2', name: 'think', input: { content: TILDE_THINK_4416 } },
        { type: 'tool_use', id: 'ping-1', name: 'tools--ping', input: {} },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([] as ContentBlock[]),
    ], { pauseAfterFirstToolRound: true });
    membrane.queueScenario([
      createMockResponse(makeToolRound('next inference should now be public'), 'tool_use'),
      createMockResponse([] as ContentBlock[]),
    ]);
    const { dir, framework, routed } = await createFramework({ policy: 'private', membrane });
    try {
      framework.start();
      trigger(framework);
      await waitFor(() => membrane.calls.length === 1);
      await waitFor(() => (membrane.lastStream as PausedAfterFirstToolRoundStream | null)?.receivedToolResults.length === 1);
      assert.match(thinkDescription(membrane.calls[0]), /withheld from channel routing/);
      assert.deepEqual(routed, []);

      framework.updateAgentRuntimeSettings('agent', { sameRoundThinkTextPolicy: 'public' });
      (membrane.lastStream as PausedAfterFirstToolRoundStream).release();
      await waitFor(() => (framework as unknown as { activeStreams: Map<string, Promise<void>> }).activeStreams.size === 0);
      assert.deepEqual(routed, []);

      trigger(framework);
      await waitFor(() => membrane.calls.length === 2);
      await waitFor(() => routed.length === 1);
      assert.match(thinkDescription(membrane.calls[1]), /may still be routed publicly as your speech/);
      assert.deepEqual(routed, ['next inference should now be public']);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('same-round agent_settings updates apply immediately to preview and next request, but not to the current request snapshot', async () => {
    const membrane = new ScenarioMembrane();
    membrane.queueScenario([
      createMockResponse([
        { type: 'text', text: 'public request before update' },
        { type: 'tool_use', id: 'think-1', name: 'think', input: { content: TILDE_THINK_4416 } },
        {
          type: 'tool_use',
          id: 'settings-1',
          name: 'agent_settings',
          input: { action: 'update', same_round_think_text_policy: 'private' },
        },
        { type: 'tool_use', id: 'read-1', name: 'tools--read', input: { path: 'project/secret.txt' } },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'still public in the continuation' },
        { type: 'tool_use', id: 'think-2', name: 'think', input: { content: TILDE_THINK_4416 } },
        { type: 'tool_use', id: 'ping-1', name: 'tools--ping', input: {} },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([] as ContentBlock[]),
    ], { pauseAfterFirstToolRound: true });
    membrane.queueScenario([
      createMockResponse(makeToolRound('private on the next inference'), 'tool_use'),
      createMockResponse([] as ContentBlock[]),
    ]);
    const { dir, framework, routed } = await createFramework({ policy: 'public', membrane });
    try {
      framework.start();
      trigger(framework);
      await waitFor(() => membrane.calls.length === 1);
      await waitFor(() => (membrane.lastStream as PausedAfterFirstToolRoundStream | null)?.receivedToolResults.length === 1);

      const firstRoundResults = (membrane.lastStream as PausedAfterFirstToolRoundStream).receivedToolResults[0] as Array<{
        toolUseId: string;
        content: string;
      }>;
      assert.ok(
        firstRoundResults.some(
          (result) =>
            result.toolUseId === 'settings-1' &&
            result.content.includes('sameRoundThinkTextPolicyUpdateNote'),
        ),
      );
      assert.deepEqual(routed, ['public request before update']);
      assert.equal(
        framework.getAgentRuntimeSettings('agent').sameRoundThinkTextPolicy,
        'private',
      );
      assert.match(thinkDescription(await framework.previewActivation('agent')), /withheld from channel routing/);

      (membrane.lastStream as PausedAfterFirstToolRoundStream).release();
      await waitFor(() => routed.length === 2);
      assert.deepEqual(routed, [
        'public request before update',
        'still public in the continuation',
      ]);

      trigger(framework);
      await waitFor(() => membrane.calls.length === 2);
      await waitFor(() => (framework as unknown as { activeStreams: Map<string, Promise<void>> }).activeStreams.size === 0);
      assert.match(thinkDescription(membrane.calls[1]), /withheld from channel routing/);
      assert.deepEqual(routed, [
        'public request before update',
        'still public in the continuation',
      ]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('same-round agent_settings explicit reset restores the compatibility policy only on the next inference', async () => {
    await expectInFlightResetRestoresNextInferencePolicy({
      resetInput: { action: 'reset', settings: ['same_round_think_text_policy'] },
    });
  });

  it('same-round agent_settings reset-all restores the recipe policy only on the next inference', async () => {
    await expectInFlightResetRestoresNextInferencePolicy({
      basePolicy: 'public',
      resetInput: { action: 'reset' },
    });
  });

  it('agent_settings reset without same_round_think_text_policy omits the next-inference note', async () => {
    const membrane = new ScenarioMembrane();
    membrane.queueScenario([
      createMockResponse([
        { type: 'tool_use', id: 'settings-1', name: 'agent_settings', input: { action: 'reset', settings: ['tail_tokens'] } },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([] as ContentBlock[]),
    ], { pauseAfterFirstToolRound: true });
    const { dir, framework } = await createFramework({ membrane });
    try {
      framework.start();
      trigger(framework);
      await waitFor(() => membrane.calls.length === 1);
      await waitFor(() => (membrane.lastStream as PausedAfterFirstToolRoundStream | null)?.receivedToolResults.length === 1);

      const firstRoundResults = (membrane.lastStream as PausedAfterFirstToolRoundStream).receivedToolResults[0] as Array<{
        toolUseId: string;
        content: string;
      }>;
      const settingsResult = firstRoundResults.find((result) => result.toolUseId === 'settings-1');
      assert.ok(settingsResult, 'agent_settings reset result should be present');
      assert.doesNotMatch(settingsResult.content, /sameRoundThinkTextPolicyUpdateNote/);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preview reflects a hot policy update while an already-started activation keeps its original description snapshot', async () => {
    const membrane = new ScenarioMembrane();
    membrane.queueScenario([
      createMockResponse(makeToolRound('request snapshot stays public'), 'tool_use'),
      createMockResponse([] as ContentBlock[]),
    ], { pauseAfterFirstToolRound: true });
    const { dir, framework } = await createFramework({ policy: 'public', membrane });
    try {
      framework.start();
      trigger(framework);
      await waitFor(() => membrane.calls.length === 1);
      await waitFor(() => (membrane.lastStream as PausedAfterFirstToolRoundStream | null)?.receivedToolResults.length === 1);
      assert.match(thinkDescription(membrane.calls[0]), /may still be routed publicly as your speech/);

      framework.updateAgentRuntimeSettings('agent', { sameRoundThinkTextPolicy: 'private' });
      assert.match(
        thinkDescription(await framework.previewActivation('agent')),
        /withheld from channel routing/,
      );
      assert.match(thinkDescription(membrane.calls[0]), /may still be routed publicly as your speech/);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('private policy suppresses only the synthesized think tool, not namespaced tools named think', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'namespaced think should still route' },
      { type: 'tool_use', id: 'module-think-1', name: 'tools--think', input: { content: 'module thought' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const { dir, framework, routed } = await createFramework({ policy: 'private', membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, ['namespaced think should still route']);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('suppression logs do not include the withheld prose text', async () => {
    const membrane = new MockMembrane();
    const withheld = 'withheld private prose should not appear in logs';
    membrane.pushResponse(createMockResponse(makeToolRound(withheld), 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const { dir, framework } = await createFramework({ policy: 'private', membrane });
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.ok(errors.some((line) => line.includes('same_round_think_text_policy=private')));
      assert.ok(errors.every((line) => !line.includes(withheld)));
    } finally {
      console.error = originalError;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an ephemeral request gets its own effective think description snapshot', async () => {
    const membrane = new ScenarioMembrane();
    membrane.queueScenario([
      createMockResponse([{ type: 'text', text: 'ephemeral done' }]),
    ]);
    const { dir, framework } = await createFramework({ membrane });
    try {
      const created = await framework.createEphemeralAgent({
        name: 'ephemeral-worker',
        model: 'test-model',
        systemPrompt: 'test',
        allowedTools: 'all',
        sameRoundThinkTextPolicy: 'private',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'go' }]);
      const run = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      const result = await run;
      assert.equal(result.speech, 'ephemeral done');
      assert.match(thinkDescription(membrane.calls[0]), /withheld from channel routing/);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('legacy/no-roundContent behavior remains unchanged', async () => {
    const membrane = new LegacyNoRoundContentMembrane();
    const { dir, framework, routed } = await createFramework({ policy: 'private', membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, [TILDE_PREFACE_80]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

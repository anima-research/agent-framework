import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/framework.js';
import type { ErrorPolicy, EventResponse, Module, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { AutobiographicalStrategy } from '@animalabs/context-manager';

const CATEGORY = 'zz-category-5c1e';
const EXPLANATION = 'zz-explanation-5c1e';
const MESSAGE = 'zz-provider-message-5c1e';

type Outcome = 'reply' | 'refusal' | 'invalid';

class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void {}
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

class ScriptedMembrane extends MockMembrane {
  readonly requests: NormalizedRequest[] = [];
  constructor(private readonly script: Outcome[]) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.requests.push(structuredClone(request));
    const outcome = this.script.shift() ?? 'reply';
    if (outcome === 'invalid') {
      return new ErrorStream(new MembraneError({
        type: 'invalid_request', retryable: false, httpStatus: 400,
        message: `Bad request: ${MESSAGE}`, rawError: { body: MESSAGE },
      }));
    }
    const response = outcome === 'refusal'
      ? { ...createMockResponse([], 'refusal'), raw: { request: {}, response: { stop_details: { category: CATEGORY, explanation: EXPLANATION } } } } as unknown as NormalizedResponse
      : createMockResponse([{ type: 'text', text: `reply ${this.requests.length}` } as ContentBlock]);
    return new MockYieldingStream([response]);
  }
}

class Speaker implements Module {
  readonly name = 'speaker';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'user', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

const noRetry: ErrorPolicy = { maxRetries: 0, onInferenceError: () => ({ retry: false }) };

type Rig = {
  framework: AgentFramework;
  requests: NormalizedRequest[];
  errs: string[];
  say(content: string, until: number): Promise<void>;
  until(count: number): Promise<void>;
  stored(): Array<{ metadata?: Record<string, unknown> }>;
};

const STRATEGIES: Array<[string, (() => unknown) | undefined]> = [
  ['the default strategy', undefined],
  ['AutobiographicalStrategy', () => new AutobiographicalStrategy({ autoTickOnNewMessage: false })],
];

async function withRig(script: Outcome[], strategy: (() => unknown) | undefined, body: (rig: Rig) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'provider-text-next-request-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { errs.push(args.map(String).join(' ')); };
  const membrane = new ScriptedMembrane(script);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout', ...(strategy ? { strategy: strategy() } : {}) }],
    modules: [new Speaker()], syncIntervalMs: 0, maintenanceIntervalMs: 0, errorPolicy: noRetry,
  } as never);
  const until = async (count: number) => {
    for (let i = 0; i < 200 && membrane.requests.length < count; i++) {
      await framework.runUntilIdle();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await framework.runUntilIdle();
  };
  try {
    await body({
      framework, requests: membrane.requests, errs, until,
      say: async (content, count) => {
        framework.pushEvent({ type: 'external-message', source: 'test', content, metadata: {} } as unknown as ProcessEvent);
        await until(count);
      },
      stored: () => framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ metadata?: Record<string, unknown> }>,
    });
  } finally {
    await framework.stop();
    console.error = orig;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertCarries(request: NormalizedRequest, text: string, what: string): void {
  assert.ok(JSON.stringify(request).includes(text), `the premise: the request carries ${what}`);
}

const REWIND_MARKER = 'most recent turn(s) were set aside';
const FAILED_TURN_NOTE = '[inference-failed] Your previous turn did not complete';

function assertHoldsNoProviderText(request: NormalizedRequest): void {
  const whole = JSON.stringify(request);
  for (const sentinel of [CATEGORY, EXPLANATION, MESSAGE]) {
    const at = whole.indexOf(sentinel);
    assert.equal(at, -1, `the request holds ${sentinel}: …${whole.slice(Math.max(0, at - 240), at + 60)}…`);
  }
}

for (const [label, strategy] of STRATEGIES) {
  test(`after a forced rewind on a refusal, the agent's next request holds neither the refusal's category nor its explanation, with ${label}`, async () => {
    await withRig(['reply', 'refusal', 'refusal', 'reply'], strategy, async (rig) => {
      await rig.say('first question', 1);
      await rig.say('second question', 2);
      const started = await (rig.framework as unknown as {
        handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<{ started?: boolean }>;
      }).handleHostCommand('test-server', { command: 'unstick', agentName: 'scout' });
      assert.equal(started.started, true);
      await rig.until(4);
      assert.equal(rig.requests.length, 4, "the turn, the refused turn, the unstick's refused run, and its retry");
      assert.ok(rig.stored().some((m) => m.metadata?.kind === 'refusal-rewind' && m.metadata.category === CATEGORY),
        'the premise: the unstick rewound on a refusal with that category');
      assertCarries(rig.requests[3]!, REWIND_MARKER, 'the rewind marker');
      assertHoldsNoProviderText(rig.requests[3]!);
    });
  });

  test(`after the breaker's rewind on an invalid request, the agent's next request holds none of the provider's message, with ${label}`, async () => {
    await withRig(['invalid', 'invalid', 'invalid', 'reply'], strategy, async (rig) => {
      for (let turn = 0; turn < 3; turn++) await rig.say(`hello ${turn}`, turn + 1);
      await rig.until(4);
      assert.equal(rig.requests.length, 4, 'three failed turns, and the retry on the rewound history');
      assert.ok(rig.errs.some((line) => line.startsWith('[inference-rewind] agent=scout auto-quarantined')), 'the premise: the third failure shed a turn');
      assertCarries(rig.requests[3]!, REWIND_MARKER, 'the rewind marker');
      assertHoldsNoProviderText(rig.requests[3]!);
    });
  });

  test(`after a failed turn, the agent's next request holds none of the provider's message, with ${label}`, async () => {
    await withRig(['invalid', 'reply'], strategy, async (rig) => {
      await rig.say('hello 0', 1);
      assert.ok(rig.stored().some((m) => m.metadata?.kind === 'inference-failed' && String(m.metadata.reason).includes(MESSAGE)),
        "the premise: the failed turn's row was written, and its record keeps the message");
      await rig.say('hello 1', 2);
      assert.equal(rig.requests.length, 2, 'the failed turn and the next');
      assertCarries(rig.requests[1]!, FAILED_TURN_NOTE, "the failed turn's note");
      assertHoldsNoProviderText(rig.requests[1]!);
    });
  });
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { MembraneErrorType, NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { OverBudgetError } from '@animalabs/context-manager';
import type { ErrorPolicy, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';
import { HealthModule } from '../src/modules/health/index.js';
import type { JsStore } from '@animalabs/chronicle';

const SENTINEL = 'zz-provider-words-7f3a';

const providerError = (type: MembraneErrorType = 'invalid_request', httpStatus = 400) => new MembraneError({
  type,
  retryable: false,
  httpStatus,
  providerErrorCode: `code_${SENTINEL}`,
  message: `Bad request: ${SENTINEL} echoed the request`,
  rawError: { body: SENTINEL },
});

class UnknownError extends Error {}

type Site = 'start' | 'stream' | 'thrown';
const SITES: readonly Site[] = ['start', 'stream', 'thrown'];

class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  constructor(private readonly error: Error, private readonly thrown: boolean) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void {}
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (this.thrown) throw this.error;
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

class AbortedStream extends ErrorStream {
  constructor() { super(new Error('unused'), false); }
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'aborted', reason: 'error', message: `aborted: ${SENTINEL}` } as unknown as StreamEvent;
  }
}

class AbortingFirst extends MockMembrane {
  sent = 0;
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    this.sent++;
    return this.sent > 1 ? new MockYieldingStream([createMockResponse([{ type: 'text', text: 'answered' }])]) : new AbortedStream();
  }
}

class FailingFirst extends MockMembrane {
  sent = 0;
  constructor(private readonly site: Site, private readonly error: Error) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    this.sent++;
    if (this.sent > 1) return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'answered' }])]);
    if (this.site === 'start') throw this.error;
    return new ErrorStream(this.error, this.site === 'thrown');
  }
}

class Asker implements Module {
  readonly name = 'asker';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

function assertCopyOf(cause: unknown, error: Error): void {
  assert.ok(cause instanceof Error, 'the rejection has a cause');
  assert.notEqual(cause, error, 'a copy, not the error itself');
  const fields = (e: unknown) => {
    const { name, message, type, retryable, httpStatus, providerErrorCode, retryAfterMs } = e as Record<string, unknown>;
    return { name, message, type, retryable, httpStatus, providerErrorCode, retryAfterMs };
  };
  assert.deepEqual(fields(cause), fields(error));
  assert.ok(!('rawError' in cause) && !('rawRequest' in cause), 'with no raw error or request');
}

const noRetry: ErrorPolicy = { maxRetries: 0, onInferenceError: () => ({ retry: false }) };

async function withFramework<T>(membrane: MockMembrane, resident: boolean, body: (fw: AgentFramework, stderr: string[]) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'af-provider-words-'));
  const stderr: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')); };
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: resident ? [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }] : [],
    modules: [new Asker()],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
    errorPolicy: noRetry,
  });
  try {
    return await body(fw, stderr);
  } finally {
    await fw.stop();
    console.error = error;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function residentTurn(membrane: MockMembrane): Promise<{ texts: string[]; markers: string[]; stderr: string[] }> {
  return withFramework(membrane, true, async (fw, stderr) => {
    fw.start();
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'Hello?', metadata: {} } as unknown as ProcessEvent);
    await fw.runUntilIdle();
    const rows = (fw.getAgent('resident')!.getContextManager() as unknown as { getAllMessages(): Array<{ content: Array<{ type: string; text?: string }> }> }).getAllMessages();
    const texts = rows.flatMap((row) => row.content).flatMap((block) => (typeof block.text === 'string' ? [block.text] : []));
    return { texts, markers: texts.filter((text) => text.startsWith('[inference-failed]')), stderr: [...stderr] };
  });
}

async function healthAfterTurn(membrane: MockMembrane): Promise<{ shown: unknown[]; logged: unknown[] }> {
  return withFramework(membrane, true, async (fw) => {
    fw.start();
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'Hello?', metadata: {} } as unknown as ProcessEvent);
    await fw.runUntilIdle();
    const health = new HealthModule({ timeZone: 'UTC' });
    health.bind(fw, {} as JsStore);
    const result = await health.handleToolCall({ id: 'h1', name: 'snapshot', input: { includeSubagents: false, includeTokens: false } } as unknown as ToolCall);
    assert.equal(result.success, true, String(result.error));
    const shown = (result.data as { inferences: { recentErrors: Array<{ error: unknown }> } }).inferences.recentErrors.map((e) => e.error);
    const logged = fw.queryInferenceLogs({ limit: 20 }).entries.map((e) => (e.summary ?? e.entry).error);
    return { shown, logged };
  });
}

async function ephemeralEnding(membrane: MockMembrane): Promise<unknown> {
  return withFramework(membrane, false, async (fw) => {
    const created = await fw.createEphemeralAgent({ name: 'helper', model: 'test-model', systemPrompt: 'Do the task.' });
    created.contextManager.addMessage('User', [{ type: 'text', text: 'Go.' }]);
    const run = fw.runEphemeralToCompletion(created.agent, created.contextManager);
    fw.start();
    return run.then(() => assert.fail('the run should reject'), (error: unknown) => error);
  });
}

describe("a provider's words stay out of what an agent reads", () => {
  for (const site of SITES) {
    it(`a resident's turn that fails on a provider's error (${site}) is told what failed in the framework's words, and the provider's go to stderr`, async () => {
      const turn = await residentTurn(new FailingFirst(site, providerError()));
      assert.equal(turn.markers.length, 1, JSON.stringify(turn.texts));
      assert.equal(turn.markers[0],
        '[inference-failed] Your previous turn did not complete: the model call failed (invalid_request, HTTP 400) and produced no response, ' +
        'so nothing was sent. If this recurs with the same cause, change approach rather than retrying identically ' +
        '(e.g. drop an oversized attachment or an unsupported setting).');
      assert.ok(!turn.texts.some((text) => text.includes(SENTINEL)), JSON.stringify(turn.texts));
      assert.ok(turn.stderr.some((line) => line.startsWith('[inference-failed]') && line.includes(SENTINEL)), 'stderr keeps the provider\'s words');
    });

    it(`health--snapshot lists a turn that failed on a provider's error (${site}) in the framework's words, and the inference log keeps the provider's`, async () => {
      const { shown, logged } = await healthAfterTurn(new FailingFirst(site, providerError()));
      if (site === 'start') {
        assert.deepEqual(shown, [], 'a call that fails before its stream exists writes no inference-log entry');
        return;
      }
      assert.ok(shown.length >= 1, JSON.stringify(shown));
      for (const error of shown) assert.match(String(error), /the model call failed \(invalid_request, HTTP 400\)$/);
      assert.ok(!shown.some((error) => String(error).includes(SENTINEL)), JSON.stringify(shown));
      assert.ok(logged.some((error) => String(error).includes(SENTINEL)), "the inference log keeps the provider's words");
    });

    it(`an ephemeral run that ends on a provider's error (${site}) rejects in the framework's words, with a copy of the error as its cause`, async () => {
      const error = providerError();
      const ending = await ephemeralEnding(new FailingFirst(site, error)) as Error;
      assert.ok(ending instanceof Error);
      assert.equal(ending.message, 'the model call failed (invalid_request, HTTP 400)');
      assertCopyOf(ending.cause, error);
    });
  }

  it("a resident's turn that fails on an error that says nothing of its origin is told only that it failed", async () => {
    const turn = await residentTurn(new FailingFirst('start', new UnknownError(`odd: ${SENTINEL}`)));
    assert.equal(turn.markers.length, 1, JSON.stringify(turn.texts));
    assert.match(turn.markers[0]!, /^\[inference-failed\] Your previous turn did not complete: the model call failed and produced no response, so nothing was sent\. If this recurs/);
    assert.ok(!turn.texts.some((text) => text.includes(SENTINEL)), JSON.stringify(turn.texts));
  });

  it('an ephemeral run that ends on an error that says nothing of its origin rejects saying its turn failed, with a copy of the error as its cause', async () => {
    const error = new UnknownError(`odd: ${SENTINEL}`);
    const ending = await ephemeralEnding(new FailingFirst('stream', error)) as Error;
    assert.equal(ending.message, 'the turn failed');
    assertCopyOf(ending.cause, error);
  });

  it("a resident's turn that fails on a safety error names no classification", async () => {
    const turn = await residentTurn(new FailingFirst('stream', providerError('safety', 400)));
    assert.equal(turn.markers.length, 1, JSON.stringify(turn.texts));
    assert.match(turn.markers[0]!, /^\[inference-failed\] Your previous turn did not complete: the model call failed and produced no response, so nothing was sent\. If this recurs/);
    assert.ok(!turn.texts.some((text) => text.includes(SENTINEL) || /safety/i.test(text)), JSON.stringify(turn.texts));
  });

  it('an ephemeral run that ends on a safety error rejects saying its request couldn\'t be completed', async () => {
    const ending = await ephemeralEnding(new FailingFirst('stream', providerError('safety', 400))) as Error;
    assert.equal(ending.message, "the request couldn't be completed");
  });

  it("a resident's turn whose stream aborts on an error is told so in the framework's words", async () => {
    const turn = await residentTurn(new AbortingFirst());
    assert.equal(turn.markers.length, 1, JSON.stringify(turn.texts));
    assert.match(turn.markers[0]!, /so nothing was sent\. Reason: Stream aborted: error\. If this recurs/);
    assert.ok(!turn.texts.some((text) => text.includes(SENTINEL)), JSON.stringify(turn.texts));
  });

  it("context-manager's refusal of a compile is told in context-manager's own words", async () => {
    const refusal = new OverBudgetError({ budget: 100, actual: 250, diagnostics: {} as never });
    const turn = await residentTurn(new FailingFirst('start', refusal));
    assert.equal(turn.markers.length, 1, JSON.stringify(turn.texts));
    assert.ok(turn.markers[0]!.includes(`Reason: ${refusal.message}.`), turn.markers[0]);
    const ending = await ephemeralEnding(new FailingFirst('start', refusal)) as Error;
    assert.equal(ending.message, refusal.message);
    assertCopyOf(ending.cause, refusal);
  });
});

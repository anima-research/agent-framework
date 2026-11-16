import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { MembraneErrorType, NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
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

const noRetry: ErrorPolicy = { maxRetries: 0, onInferenceError: () => ({ retry: false }) };

async function withFramework<T>(membrane: MockMembrane, body: (fw: AgentFramework) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'af-provider-words-'));
  const error = console.error;
  console.error = () => {};
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
    modules: [new Asker()],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
    errorPolicy: noRetry,
  });
  try {
    return await body(fw);
  } finally {
    await fw.stop();
    console.error = error;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function healthAfterTurn(membrane: MockMembrane): Promise<{ shown: unknown[]; logged: unknown[] }> {
  return withFramework(membrane, async (fw) => {
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

describe("a provider's words stay out of what health--snapshot shows an agent", () => {
  for (const site of SITES) {
    it(site === 'start'
      ? "health--snapshot lists no error for a turn whose model call fails before its stream exists, since the inference log has no entry for it"
      : `health--snapshot lists a turn that failed on a provider's error (${site}) in the framework's words, and the inference log keeps the provider's`, async () => {
      const membrane = new FailingFirst(site, providerError());
      const { shown, logged } = await healthAfterTurn(membrane);
      if (site === 'start') {
        assert.equal(membrane.sent, 1, 'the model call was made, and failed before its stream existed');
        assert.deepEqual(shown, []);
        assert.deepEqual(logged, []);
        return;
      }
      assert.ok(shown.length >= 1, JSON.stringify(shown));
      for (const error of shown) assert.match(String(error), /the model call failed \(invalid_request, HTTP 400\)$/);
      assert.ok(!shown.some((error) => String(error).includes(SENTINEL)), JSON.stringify(shown));
      assert.ok(logged.some((error) => String(error).includes(SENTINEL)), "the inference log keeps the provider's words");
    });
  }
});

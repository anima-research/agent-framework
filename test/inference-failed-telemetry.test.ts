import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { ErrorPolicy, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

class InputModule implements Module {
  readonly name = 'input';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return [{ name: 'zz_look', description: 'zz look', inputSchema: { type: 'object', properties: {} } }]; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: 'zz-looked' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

class ToolRoundThenErrorStream implements YieldingStream {
  isCancelled = false;
  toolDepth = 0;
  private waiting = true;
  private resume?: () => void;
  constructor(private readonly error: Error) {}
  get isWaitingForTools() { return this.waiting; }
  get pendingToolCallIds() { return this.waiting ? ['zz-call'] : []; }
  provideToolResults(): void { this.waiting = false; this.toolDepth = 1; this.resume?.(); }
  cancel(): void { this.isCancelled = true; this.waiting = false; this.resume?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    const call = { id: 'zz-call', name: 'input--zz_look', input: {} };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 } } as StreamEvent;
    yield { type: 'tool-calls', calls: [call], context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '',
      roundContent: [{ type: 'tool_use', ...call }], supportsInjectedMessages: true } } as StreamEvent;
    if (this.waiting) await new Promise<void>((resolve) => { this.resume = resolve; });
    if (this.isCancelled) return;
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

const serverError = () => new MembraneError({
  type: 'server', retryable: true, httpStatus: 502, providerErrorCode: 'zz_bad_gateway', message: 'zz server failure', rawError: undefined,
} as never);
const timeoutError = () => new MembraneError({ type: 'timeout', retryable: true, message: 'zz call timed out', rawError: undefined } as never);

type Send = 'fails' | 'tool round, then fails' | 'tool round, then times out' | 'answers';

class ScriptedMembrane extends MockMembrane {
  readonly sends: NormalizedRequest[] = [];
  constructor(private readonly script: (send: number) => Send) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.sends.push(request);
    const send = this.script(this.sends.length);
    if (send === 'fails') return new ErrorStream(serverError());
    if (send === 'tool round, then fails') return new ToolRoundThenErrorStream(serverError());
    if (send === 'tool round, then times out') return new ToolRoundThenErrorStream(timeoutError());
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: `zz-answer-${this.sends.length}` }])]);
  }
}

const noRetry: ErrorPolicy = { maxRetries: 0, onInferenceError: () => ({ retry: false }) };

const texts = (request: NormalizedRequest) =>
  request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').filter((t) => t !== '');

async function resident(t: TestContext, membrane: ScriptedMembrane, dir = mkdtempSync(join(tmpdir(), 'af-979-'))) {
  const cwd = process.cwd();
  process.chdir(dir);
  const stderr: string[] = [];
  const consoleError = console.error;
  console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(' ')); };
  const open = () => AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    errorPolicy: noRetry, exhaustedTurnRearmMs: false,
  });
  let fw = await open();
  const traces: Array<{ type: string }> = [];
  const listen = () => fw.onTrace((e) => traces.push(e as unknown as { type: string }));
  listen();
  t.after(async () => {
    await fw.stop();
    console.error = consoleError;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get fw() { return fw; },
    stderr, traces,
    async say(text: string) {
      fw.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} });
      await fw.runUntilIdle();
    },
    stored: () => fw.getAgent('resident')!.getContextManager().queryMessages({}).messages,
    notes: () => fw.getAgent('resident')!.getContextManager().queryMessages({}).messages
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'inference-failed')
      .map((m) => (m.content[0] as { text: string }).text),
    failures: () => {
      const file = join(dir, 'logs', 'failures.log');
      return existsSync(file) ? readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
    },
    async reopen() {
      await fw.stop();
      fw = await open();
      listen();
    },
  };
}

test('three exhausted turns that did nothing: three failure records, and no row in the context but what was said', async (t) => {
  const membrane = new ScriptedMembrane(() => 'fails');
  const r = await resident(t, membrane);
  for (const n of [1, 2, 3]) await r.say(`zz-hello ${n}`);
  assert.equal(r.traces.filter((e) => e.type === 'inference:exhausted').length, 3, 'premise: three turns exhausted');
  assert.deepEqual(r.notes(), []);
  assert.deepEqual(r.stored().flatMap((m) => m.content).map((b) => (b as { text?: string }).text), ['zz-hello 1', 'zz-hello 2', 'zz-hello 3']);
  const records = r.failures().filter((f) => f.kind === 'inference-exhausted');
  assert.deepEqual(records.map((f) => f.consecutive), [1, 2, 3]);
  assert.equal(r.stderr.filter((l) => l.startsWith('[inference-failed] agent=resident consecutive=')).length, 3);
});

test('operators keep what a failure tells them: its category, status and provider code in failures.log and stderr, and its request id in the inference log', async (t) => {
  const membrane = new ScriptedMembrane(() => 'fails');
  const r = await resident(t, membrane);
  await r.say('zz-hello');
  const [record] = r.failures().filter((f) => f.kind === 'inference-exhausted');
  const { at, ...fields } = record!;
  assert.equal(typeof at, 'string');
  assert.deepEqual(fields, {
    agent: 'resident', consecutive: 1, reason: 'zz server failure', kind: 'inference-exhausted',
    errorType: 'server', retryable: true, httpStatus: 502, providerErrorCode: 'zz_bad_gateway',
  });
  assert.ok(r.stderr.includes('[inference-failed] agent=resident consecutive=1 type=server status=502 code=zz_bad_gateway: zz server failure'), r.stderr.join('\n'));
  const logged = r.fw.queryInferenceLogs({}).entries.map(({ summary }) => summary);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.success, false);
  assert.match(logged[0]!.requestId ?? '', /^resident-\d+-[a-z0-9]+$/);
});

test('a framework reopened on the store after turns that did nothing holds none of them', async (t) => {
  const membrane = new ScriptedMembrane(() => 'fails');
  const r = await resident(t, membrane);
  for (const n of [1, 2, 3]) await r.say(`zz-hello ${n}`);
  assert.equal(r.traces.filter((e) => e.type === 'inference:exhausted').length, 3, 'premise: three turns exhausted');
  await r.reopen();
  assert.deepEqual(r.notes(), []);
  assert.deepEqual(r.stored().flatMap((m) => m.content).map((b) => (b as { text?: string }).text), ['zz-hello 1', 'zz-hello 2', 'zz-hello 3']);
});

test('seventeen failures leave each next request as it would be without them: what was said before, and the new message', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 17 ? 'fails' : 'answers'));
  const r = await resident(t, membrane);
  for (let n = 1; n <= 18; n++) await r.say(`zz-hello ${n}`);
  assert.equal(membrane.sends.length, 18, 'premise: seventeen failed sends, then one that answered');
  assert.equal(r.traces.filter((e) => e.type === 'inference:exhausted').length, 17, 'premise: seventeen turns exhausted');
  assert.ok(r.stored().some((m) => m.content.some((b) => (b as { text?: string }).text === 'zz-answer-18')), 'premise: the eighteenth answered');
  for (let n = 1; n < 18; n++) {
    assert.deepEqual(texts(membrane.sends[n]!), [...texts(membrane.sends[n - 1]!), `zz-hello ${n + 1}`], `send ${n + 1}`);
  }
  assert.equal(texts(membrane.sends[17]!).filter((text) => text.startsWith('zz-hello')).length, 18);
});

test('a turn that got partway leaves one note, saying how far it got and why, with no advice', async (t) => {
  const membrane = new ScriptedMembrane(() => 'tool round, then fails');
  const r = await resident(t, membrane);
  await r.say('zz-hello');
  assert.deepEqual(r.notes(), [
    '[inference-failed] Your previous turn did not complete: it failed (server, HTTP 502). ' +
    'Its earlier rounds ran, and their tool calls ran as their results show. Reason: zz server failure.',
  ]);
  assert.equal(r.failures().filter((f) => f.kind === 'inference-exhausted').length, 1);
});

test('a turn that got partway and timed out keeps its note telling the resident it can still reply', async (t) => {
  const membrane = new ScriptedMembrane(() => 'tool round, then times out');
  const r = await resident(t, membrane);
  await r.say('zz-hello');
  const notes = r.notes();
  assert.equal(notes.length, 1, notes.join('\n'));
  assert.match(notes[0]!, /^\[inference-failed\] Your previous turn did not complete: its last call timed out\. Its earlier rounds ran, and their tool calls ran as their results show\. Reason: zz call timed out\. If a reply is still owed from that turn, you can give it now\.$/);
});

test('SUPPRESS_INFERENCE_FAILED_MARKER=1 leaves out the note for a turn that got partway', async (t) => {
  const previous = process.env.SUPPRESS_INFERENCE_FAILED_MARKER;
  process.env.SUPPRESS_INFERENCE_FAILED_MARKER = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.SUPPRESS_INFERENCE_FAILED_MARKER;
    else process.env.SUPPRESS_INFERENCE_FAILED_MARKER = previous;
  });
  const membrane = new ScriptedMembrane(() => 'tool round, then fails');
  const r = await resident(t, membrane);
  await r.say('zz-hello');
  assert.equal(r.traces.filter((e) => e.type === 'inference:exhausted').length, 1, 'premise: the turn exhausted');
  assert.ok(r.stored().some((m) => JSON.stringify(m.content).includes('zz-looked')), 'premise: the turn got partway, its round in the context with its result');
  assert.deepEqual(r.notes(), []);
  assert.equal(r.failures().filter((f) => f.kind === 'inference-exhausted').length, 1);
});

/**
 * Failure text is bounded in every sink the framework writes it to.
 *
 * A failure's text is whatever its source put in `Error.message`, and a
 * provider can echo the whole rejected request there. In one household an
 * OpenAI-compatible 400 echoed ~1.7 MB, and the framework stored it in the
 * resident's own context as an [inference-failed] marker, wrote it to
 * stderr and failures.log, and traced it. These tests drive ~1 MB reasons
 * through the real failure paths and through each sink, and check that what
 * a small failure produced before is produced unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { ContextEntry, ContextLogView, ContextStrategy, MessageStoreView, ReadinessState, StrategyContext, TokenBudget } from '@animalabs/context-manager';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { AgentFramework as FrameworkClass } from '../src/framework.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const MEGA = 1_000_000;
/** ~1 MB of echoed request with a recognizable head and tail. */
const echo = (n = MEGA) => `zz-head ${'e'.repeat(n)} zz-tail`;
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function hugeProviderError(request?: NormalizedRequest): MembraneError {
  return new MembraneError({
    type: 'invalid_request',
    retryable: false,
    httpStatus: 400,
    providerErrorCode: 'zz_bad_request',
    message: `Bad request: ${echo()}`,
    rawError: { status: 400 },
    rawRequest: request ?? { system: echo() },
  });
}

// ---------------------------------------------------------------------------
// The private sinks, on a prototype instance (the pattern of
// inference-failure-observability.test.ts).
// ---------------------------------------------------------------------------

function makeHarness(opts?: { tick?: () => Promise<void>; addMessage?: (p: string, c: any[], m: any) => void }) {
  const fw = Object.create(FrameworkClass.prototype) as any;
  fw.consecutiveInferenceFailures = new Map<string, number>();
  fw.inferenceFailureEscalationThreshold = 3;
  fw.exhaustionRewinds = new Map<string, number>();
  fw.rewindEpisode = new Map();
  fw.lastInferenceAt = new Map<string, object>();
  fw.pendingRequests = [];
  fw.overBudgetDrainInFlight = new Set<string>();
  fw.opsAlertLastSent = new Map<string, number>();
  fw.opsAlertCooldownMs = 15 * 60_000;
  const traces: any[] = [];
  fw.traceListeners = [(e: any) => traces.push(e)];
  const logged: Array<Record<string, unknown>> = [];
  fw.logFailure = (r: Record<string, unknown>) => logged.push(r);
  const markers: Array<{ text: string; meta: any }> = [];
  let ticks = 0;
  fw.agents = new Map([['cairn', {
    name: 'cairn',
    refusalHandling: { maxRewinds: 3 },
    getContextManager: () => ({
      addMessage: opts?.addMessage ?? ((_p: string, content: any[], meta: any) => { markers.push({ text: content[0].text, meta }); }),
      tick: async () => { ticks++; await opts?.tick?.(); },
    }),
  }]]);
  const errs: string[] = [];
  // The arguments as passed: printing an object (rather than a string built
  // from it) is what wrote a MembraneError's whole rawRequest to stderr.
  const rawArgs: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { rawArgs.push(a); errs.push(a.map(String).join(' ')); };
  const restore = () => { console.error = orig; };
  return { fw, traces, logged, markers, errs, rawArgs, restore, ticks: () => ticks };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

test('a ~1 MB classified reason: bounded marker, logs and stderr, with the classification beside the text', () => {
  const { fw, markers, logged, errs, restore } = makeHarness();
  const reason = `Bad request: ${echo()}`;
  try {
    fw.noteInferenceExhausted('cairn', reason, false, 'invalid_request', { httpStatus: 400, providerErrorCode: 'zz_bad_request' });
  } finally { restore(); }

  assert.equal(markers.length, 1);
  const { text, meta } = markers[0];
  assert.ok(text.length < 1_200, `marker text is ${text.length} chars`);
  assert.match(text, /^\[inference-failed\] Your previous turn did not complete: the model call failed \(invalid_request, HTTP 400\) and produced no response/);
  assert.match(text, /Reason: Bad request: zz-head e+ …\[\d+ of \d+ characters omitted\]… e+ zz-tail\. If this recurs/);
  assert.ok(meta.reason.length <= 600);
  assert.equal(meta.kind, 'inference-failed');
  assert.equal(meta.errorType, 'invalid_request');
  assert.equal(meta.retryable, false);
  assert.equal(meta.httpStatus, 400);
  assert.equal(meta.providerErrorCode, 'zz_bad_request');
  assert.equal(meta.reasonChars, reason.length);

  assert.equal(logged.length, 1);
  assert.ok((logged[0].reason as string).length <= 2_000);
  assert.deepEqual(
    { kind: logged[0].kind, errorType: logged[0].errorType, httpStatus: logged[0].httpStatus, providerErrorCode: logged[0].providerErrorCode, reasonChars: logged[0].reasonChars },
    { kind: 'inference-exhausted', errorType: 'invalid_request', httpStatus: 400, providerErrorCode: 'zz_bad_request', reasonChars: reason.length },
  );

  const line = errs.find((e) => e.startsWith('[inference-failed]'))!;
  assert.ok(line.length < 2_200, `stderr line is ${line.length} chars`);
  assert.match(line, /^\[inference-failed\] agent=cairn consecutive=1 type=invalid_request status=400 code=zz_bad_request: Bad request: zz-head/);
});

test('a small unclassified reason produces exactly the marker it did before', () => {
  const { fw, markers, logged, errs, restore } = makeHarness();
  try {
    fw.noteInferenceExhausted('cairn', '400 image exceeds 5 MB');
  } finally { restore(); }
  assert.equal(markers[0].text,
    '[inference-failed] Your previous turn did not complete: the model call failed and produced no response, ' +
    'so nothing was sent. Reason: 400 image exceeds 5 MB. If this recurs with the same cause, change approach ' +
    'rather than retrying identically (e.g. drop an oversized attachment or an unsupported setting).');
  assert.deepEqual(markers[0].meta, { system: true, kind: 'inference-failed', reason: '400 image exceeds 5 MB', consecutive: 1 });
  assert.deepEqual(logged[0], { agent: 'cairn', consecutive: 1, reason: '400 image exceeds 5 MB', kind: 'inference-exhausted' });
  assert.ok(errs.includes('[inference-failed] agent=cairn consecutive=1: 400 image exceeds 5 MB'));
});

test('no excerpt splits a surrogate pair, at any cut position', () => {
  // A pair at every position of a reason longer than both bounds, so that
  // wherever the cuts fall, some position straddles each of them.
  const length = 2_500;
  const omission = new RegExp(` …\\[(\\d+) of ${length} characters omitted\\]… `);
  for (let at = 0; at <= length - 2; at++) {
    const { fw, markers, logged, restore } = makeHarness();
    try {
      fw.noteInferenceExhausted('cairn', `${'x'.repeat(at)}😀${'x'.repeat(length - 2 - at)}`, false, 'invalid_request');
    } finally { restore(); }
    for (const [excerpt, max] of [[markers[0].meta.reason as string, 600], [logged[0].reason as string, 2_000]] as const) {
      const where = `pair at ${at}, ${max}-character excerpt`;
      assert.equal(loneSurrogate.test(excerpt), false, `${where}: a lone surrogate`);
      assert.ok(excerpt.length <= max, `${where}: ${excerpt.length} characters`);
      // A cut moved off a pair omits one more character, and says so.
      const stated = omission.exec(excerpt);
      assert.ok(stated, `${where}: no omission marker`);
      assert.equal(excerpt.length - stated[0].length + Number(stated[1]), length, `${where}: the stated omission`);
    }
  }
});

test('an over-budget phrase quoted inside a classified provider error does not kick the drain', async () => {
  const quoted = `Bad request. Request: [inference-failed] ... Context would exceed hard budget ... no summary covers ${echo(10_000)}`;
  const classified = makeHarness();
  try {
    classified.fw.noteInferenceExhausted('cairn', quoted, false, 'invalid_request', { httpStatus: 400 });
    await settle();
  } finally { classified.restore(); }
  assert.equal(classified.ticks(), 0, 'a classified 400 is not an over-budget compile');
  assert.equal(classified.traces.filter((t) => t.type === 'ops:alert' && t.kind === 'context-refusal').length, 0);

  // The fallback still serves the unclassified string it exists for.
  const unclassified = makeHarness();
  try {
    unclassified.fw.noteInferenceExhausted('cairn', 'Context would exceed hard budget (90000 > 80000)');
    await settle();
  } finally { unclassified.restore(); }
  assert.equal(unclassified.ticks(), 8);

  // ...decided on the whole reason, even where the excerpts omit the phrase.
  const long = makeHarness();
  try {
    long.fw.noteInferenceExhausted('cairn', `${'x'.repeat(50_000)} Context would exceed hard budget ${'y'.repeat(50_000)}`);
    await settle();
  } finally { long.restore(); }
  assert.equal(long.ticks(), 8, 'presentation bounds never change the decision');
});

test('each excerpt states the whole length when it was cut, and only then', () => {
  const { fw, markers, logged, restore } = makeHarness();
  const reason = `zz-reason ${'r'.repeat(990)}`; // 1,000 chars: cut for the marker, whole in the logs
  try {
    fw.noteInferenceExhausted('cairn', reason, false, 'invalid_request');
  } finally { restore(); }
  assert.ok(markers[0].meta.reason.length <= 600);
  assert.equal(markers[0].meta.reasonChars, 1_000);
  assert.equal(logged[0].reason, reason);
  assert.equal('reasonChars' in logged[0], false);
});

/** Every argument a failure log passed is a bounded string: no object for the runtime to inspect. */
function assertBoundedStrings(rawArgs: unknown[][], marker: string): string {
  const call = rawArgs.find((args) => typeof args[0] === 'string' && (args[0] as string).includes(marker));
  assert.ok(call, `a log line containing "${marker}"`);
  for (const arg of call!) assert.equal(typeof arg, 'string', `${marker}: an argument was a ${typeof arg}`);
  const line = call!.join(' ');
  assert.ok(line.length < 2_500, `${marker} line is ${line.length} chars`);
  return line;
}

test('failure logs print a bounded projection, never the error object with its request', async () => {
  // A short message with a huge request: Membrane's message cap does not help
  // here; only not printing the object does.
  const short = new MembraneError({
    type: 'invalid_request', retryable: false, httpStatus: 400, providerErrorCode: 'zz_bad_request',
    message: 'Bad request: zz-short', rawError: { status: 400 }, rawRequest: { system: echo() },
  });
  for (const error of [hugeProviderError(), short]) {
    const kicked = makeHarness({ tick: async () => { throw error; } });
    try {
      kicked.fw.noteInferenceExhausted('cairn', 'Context would exceed hard budget', undefined, 'over_budget');
      await settle();
    } finally { kicked.restore(); }
    const kick = assertBoundedStrings(kicked.rawArgs, 'drain kick failed');
    assert.match(kick, /MembraneError \(invalid_request, HTTP 400, zz_bad_request, retryable=false\): Bad request: zz-/);

    const refused = makeHarness({ addMessage: () => { throw error; } });
    try {
      refused.fw.noteInferenceExhausted('cairn', 'boom');
    } finally { refused.restore(); }
    assertBoundedStrings(refused.rawArgs, 'could not record chronicle marker');
  }

  // Every component of the projection is bounded, the name and type included.
  const named = new Error('zz-short');
  named.name = `Zz${'N'.repeat(MEGA)}`;
  (named as Error & { type?: string }).type = `t${'T'.repeat(MEGA)}`;
  const odd = makeHarness({ tick: async () => { throw named; } });
  try {
    odd.fw.noteInferenceExhausted('cairn', 'Context would exceed hard budget', undefined, 'over_budget');
    await settle();
  } finally { odd.restore(); }
  assertBoundedStrings(odd.rawArgs, 'drain kick failed');
});

test('emitTrace: listeners get bounded error and stack; the marker still learns the full length', () => {
  const { fw, traces, markers, restore } = makeHarness();
  const error = `Bad request: ${echo()}`;
  try {
    fw.emitTrace({ type: 'inference:exhausted', agentName: 'cairn', error, retryable: false, errorType: 'invalid_request', httpStatus: 400, providerErrorCode: 'zz_bad_request' });
    fw.emitTrace({ type: 'inference:failed', agentName: 'cairn', error, stack: `Error: ${error}\n    at zz (zz.js:1:1)` });
    // Any event's error string, including failure events added later.
    fw.emitTrace({ type: 'module:batch_hook_failed', agentName: 'cairn', module: 'zz', error });
  } finally { restore(); }
  const failureEvents = traces.filter((t) => typeof t.error === 'string');
  assert.equal(failureEvents.length, 3);
  for (const event of failureEvents) {
    assert.ok(event.error.length <= 2_000, `${event.type} error is ${event.error.length} chars`);
    if (event.stack) assert.ok(event.stack.length <= 2_000);
  }
  assert.equal(markers[0].meta.reasonChars, error.length);
  assert.equal(markers[0].meta.httpStatus, 400);
  assert.equal(markers[0].meta.providerErrorCode, 'zz_bad_request');
});

test('opsAlert bounds its message on the trace and the failures.log record', () => {
  const { fw, traces, logged, restore } = makeHarness();
  try {
    fw.opsAlert('hard-down', 'cairn', `3 consecutive inference failures. Last reason: ${echo()}`);
  } finally { restore(); }
  const alert = traces.find((t) => t.type === 'ops:alert');
  assert.ok(alert.message.length <= 2_000);
  assert.ok((logged[0].reason as string).length <= 2_000);
});

test('logFailure bounds every top-level string it writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-failure-bounds-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const fw = Object.create(FrameworkClass.prototype) as any;
    fw.logFailure({ agent: 'cairn', reason: echo(), note: echo(), consecutive: 1 });
    const line = readFileSync(join(dir, 'logs', 'failures.log'), 'utf-8').trim();
    assert.ok(line.length < 4_500, `failures.log line is ${line.length} chars`);
    const record = JSON.parse(line);
    assert.ok(record.reason.length <= 2_000 && record.note.length <= 2_000);
    assert.equal(record.consecutive, 1);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The real failure paths, on a real framework, store and context manager.
// ---------------------------------------------------------------------------

class InputModule implements Module {
  readonly name = 'input';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

class ErrorEventStream implements YieldingStream {
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

class ThrowingStream extends ErrorEventStream {
  constructor(private readonly thrown: Error) { super(thrown); }
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    throw this.thrown;
  }
}

type Path = 'stream error event' | 'stream throws' | 'stream setup throws';

class FailingMembrane extends MockMembrane {
  constructor(private readonly path: Path, private readonly make: (request: NormalizedRequest) => Error) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const error = this.make(request);
    if (this.path === 'stream setup throws') throw error;
    return this.path === 'stream throws' ? new ThrowingStream(error) : new ErrorEventStream(error);
  }
}

async function runFailingTurn(path: Path, make: (request: NormalizedRequest) => Error) {
  const dir = mkdtempSync(join(tmpdir(), 'af-failure-bounds-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')); };
  const membrane = new FailingMembrane(path, make);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system' }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const traces: any[] = [];
  framework.onTrace((e) => traces.push(e));
  try {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} });
    await framework.runUntilIdle();
    const messages = framework.getAgent('resident')!.getContextManager().queryMessages({}).messages;
    const markers = messages.filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'inference-failed');
    const failuresLog = existsSync(join(dir, 'logs', 'failures.log')) ? readFileSync(join(dir, 'logs', 'failures.log'), 'utf-8') : '';
    const inferenceLogs = framework.queryInferenceLogs({}).entries;
    return { markers, traces, errs, failuresLog, inferenceLogs, calls: membrane.calls.length };
  } finally {
    await framework.stop();
    console.error = orig;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const path of ['stream error event', 'stream throws', 'stream setup throws'] as const) {
  test(`${path}: a ~1 MB provider error leaves a bounded, classified trail`, async () => {
    const { markers, traces, errs, failuresLog, inferenceLogs } = await runFailingTurn(path, (request) => hugeProviderError(request));
    assert.equal(markers.length, 1, 'one failure marker');
    const text = (markers[0].content[0] as { text: string }).text;
    assert.ok(text.length < 1_200, `marker is ${text.length} chars`);
    assert.match(text, /model call failed \(invalid_request, HTTP 400\)/);
    const meta = markers[0].metadata as Record<string, unknown>;
    assert.equal(meta.errorType, 'invalid_request');
    assert.equal(meta.httpStatus, 400);
    assert.ok((meta.reasonChars as number) > MEGA);

    for (const event of traces.filter((t) => typeof t.error === 'string')) {
      assert.ok(event.error.length <= 2_000, `${event.type} error is ${event.error.length} chars`);
    }
    assert.ok(traces.some((t) => t.type === 'inference:exhausted' && t.httpStatus === 400 && t.providerErrorCode === 'zz_bad_request'));
    for (const line of failuresLog.trim().split('\n').filter(Boolean)) {
      assert.ok(line.length < 4_500, `failures.log line is ${line.length} chars`);
    }
    assert.ok(failuresLog.includes('"errorType":"invalid_request"'));
    const longest = errs.reduce((max, e) => Math.max(max, e.length), 0);
    assert.ok(longest < 4_500, `longest stderr line is ${longest} chars`);
    const loggedErrors = inferenceLogs.map(({ entry }) => entry.error).filter((e): e is string => typeof e === 'string');
    // A stream that never started writes no inference-log entry (as before);
    // the two stream paths do.
    if (path !== 'stream setup throws') assert.ok(loggedErrors.length > 0, 'the failed inference is logged');
    for (const logged of loggedErrors) {
      assert.ok(logged.length <= 2_000, `inference log error is ${logged.length} chars`);
    }
  });
}

test('a ~1 MB plain Error (no classification) is bounded the same way', async () => {
  const { markers, errs } = await runFailingTurn('stream throws', () => new Error(`socket said: ${echo()}`));
  assert.equal(markers.length, 1);
  const text = (markers[0].content[0] as { text: string }).text;
  assert.ok(text.length < 1_200);
  assert.match(text, /model call failed and produced no response/);
  const longest = errs.reduce((max, e) => Math.max(max, e.length), 0);
  assert.ok(longest < 4_500, `longest stderr line is ${longest} chars`);
});

class HugeFailureStrategy implements ContextStrategy {
  readonly name = 'huge-failure-maintenance-test';
  checkReadiness(): ReadinessState { return { ready: false, description: 'compression blocked' }; }
  async tick(_ctx: StrategyContext): Promise<void> { throw hugeProviderError(); }
  select(_store: MessageStoreView, _log: ContextLogView, _budget: TokenBudget): ContextEntry[] { return []; }
}

test('a ~1 MB maintenance failure: bounded record, ops alert and stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-failure-bounds-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')); };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: new HugeFailureStrategy() }],
    modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 10,
  });
  const traces: any[] = [];
  framework.onTrace((e) => traces.push(e));
  try {
    framework.start();
    const deadline = Date.now() + 5_000;
    while (framework.getContextMaintenanceSnapshot().history.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const record = framework.getContextMaintenanceSnapshot().history[0].agents[0];
    assert.ok(typeof record.error === 'string' && record.error.length <= 2_000, `maintenance record error is ${record.error?.length} chars`);
    assert.match(record.error!, /^Bad request: zz-head/);
    const alert = traces.find((t) => t.type === 'ops:alert' && t.kind === 'context-maintenance-failed');
    assert.ok(alert && alert.message.length <= 2_000);
    const longest = errs.reduce((max, e) => Math.max(max, e.length), 0);
    assert.ok(longest < 4_500, `longest stderr line is ${longest} chars`);
  } finally {
    await framework.stop();
    console.error = orig;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

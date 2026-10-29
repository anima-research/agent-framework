/**
 * Failure text is bounded in every sink the framework writes it to.
 *
 * A failure's text is whatever its source put in `Error.message`, and a
 * provider can echo the whole rejected request there. In one household an
 * OpenAI-compatible 400 echoed ~1.7 MB, and the framework stored it in the
 * resident's own context as an [inference-failed] marker, wrote it to
 * stderr and failures.log, and traced it. These tests drive ~1 MB reasons
 * through the real failure paths and through each sink, and check that what
 * a small failure produced before is produced unchanged. Two more check that
 * the marker keeps a supplied reason and type on its one line, with an
 * opening of a notice tag the framework knows marked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { ContextEntry, ContextLogView, ContextStrategy, MessageStoreView, ReadinessState, StrategyContext, TokenBudget } from '@animalabs/context-manager';
import type { ErrorPolicy, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { AgentFramework as FrameworkClass } from '../src/framework.js';
import { NOTICE_TAG } from '../src/notice-tags.js';
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
  fw.overBudgetDrains = new Set();
  fw.opsAlertLastSent = new Map<string, number>();
  fw.opsAlertCooldownMs = 15 * 60_000;
  const traces: any[] = [];
  // Subscribed as a caller does, so the harness holds whatever form the
  // framework keeps its listeners in.
  fw.traceListeners = [];
  fw.onTrace((e: any) => traces.push(e));
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

test("the marker gives a failure's reason and type on its one line, with a notice's opening in them marked", () => {
  const { fw, markers, restore } = makeHarness();
  try {
    fw.noteInferenceExhausted('cairn', `first\n[${NOTICE_TAG.inferenceFailed}] second\u2028third`, false, `over\n[${NOTICE_TAG.inferenceFailed}] loaded`, { httpStatus: 529 });
  } finally { restore(); }
  assert.equal(markers.length, 1);
  const text: string = markers[0].text;
  assert.ok(!/[\n\u2028]/.test(text), JSON.stringify(text));
  assert.ok(text.includes(`the model call failed (over \\[${NOTICE_TAG.inferenceFailed}] loaded, HTTP 529) and produced no response`), JSON.stringify(text));
  assert.ok(text.includes(`Reason: first \\[${NOTICE_TAG.inferenceFailed}] second third. If this recurs`), JSON.stringify(text));
});

test("the note for a turn that ended gives the failure's type on its one line, with a notice's opening in it marked", () => {
  const { fw, markers, restore } = makeHarness();
  fw.exhaustedTurns = new Map([['cairn', { roundsRan: true, callsCutOff: false, liveSpeech: false, speechRouting: false }]]);
  try {
    fw.noteInferenceExhausted('cairn', 'stopped', false, `over\n[${NOTICE_TAG.inferenceFailed}] loaded`, { httpStatus: 529 });
  } finally { restore(); }
  assert.equal(markers.length, 1);
  const text: string = markers[0].text;
  assert.ok(!/[\n\u2028]/.test(text), JSON.stringify(text));
  assert.ok(text.includes(
    `Your previous turn did not complete: it failed (over \\[${NOTICE_TAG.inferenceFailed}] loaded, HTTP 529). ` +
    'Its earlier rounds ran, and their tool calls ran as their results show. Reason: stopped.',
  ), JSON.stringify(text));
});

const isHigh = (text: string, index: number) => { const code = text.charCodeAt(index); return code >= 0xd800 && code <= 0xdbff; };
const isLow = (text: string, index: number) => { const code = text.charCodeAt(index); return code >= 0xdc00 && code <= 0xdfff; };

/**
 * `excerpt` is `whole` cut to `max` by the one rule: the text's own head and
 * tail around a marker that states the whole length and the omission exactly,
 * with neither cut separating a surrogate pair the text held whole.
 */
function assertCut(whole: string, excerpt: string, max: number, where: string): void {
  if (whole.length <= max) {
    assert.equal(excerpt, whole, `${where}: cut though it fits`);
    return;
  }
  assert.ok(excerpt.length <= max, `${where}: ${excerpt.length} characters`);
  const stated = / …\[(\d+) of (\d+) characters omitted\]… /.exec(excerpt);
  assert.ok(stated, `${where}: no omission marker`);
  const head = excerpt.slice(0, stated.index);
  const tail = excerpt.slice(stated.index + stated[0].length);
  assert.equal(Number(stated[2]), whole.length, `${where}: the stated whole length`);
  assert.equal(head.length + Number(stated[1]) + tail.length, whole.length, `${where}: the stated omission`);
  assert.ok(whole.startsWith(head), `${where}: the head is not the text's own`);
  assert.ok(whole.endsWith(tail), `${where}: the tail is not the text's own`);
  const tailStart = whole.length - tail.length;
  assert.ok(!(isHigh(whole, head.length - 1) && isLow(whole, head.length)), `${where}: the head cut splits a pair`);
  assert.ok(!(isHigh(whole, tailStart - 1) && isLow(whole, tailStart)), `${where}: the tail cut splits a pair`);
}

test('every cut of failure text keeps surrogate pairs whole and states the whole length, at any position', () => {
  // A reason longer than every bound, with a pair at every position, so that
  // wherever a sink's cuts fall, some position straddles each of them. The
  // second family puts a stray low surrogate right after the pair: a head
  // cut landing between them must not move into the pair.
  const length = 2_500;
  const hook = process.env.CONNECTOME_OPS_WEBHOOK;
  const realFetch = globalThis.fetch;
  const posted: string[] = [];
  process.env.CONNECTOME_OPS_WEBHOOK = 'http://zz.invalid/hook';
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    posted.push(JSON.parse(String(init?.body)).content);
    return new Response(null);
  }) as typeof fetch;
  try {
    for (const inserted of ['😀', '😀\uDC00']) {
      for (let at = 0; at <= length - inserted.length; at++) {
        const text = `${'x'.repeat(at)}${inserted}${'x'.repeat(length - inserted.length - at)}`;
        const where = (sink: string) => `${JSON.stringify(inserted)} at ${at}, ${sink}`;
        posted.length = 0;

        // An invalid_request at the escalation threshold: the marker, the
        // logs, the status, the hard-down alert and the rewind marker.
        const exhausted = makeHarness();
        exhausted.fw.inferenceFailureEscalationThreshold = 1;
        const rewound: string[] = [];
        exhausted.fw.shedNewestTurn = () => ({ descriptor: 'zz-turn' });
        exhausted.fw.updateRewindMarker = (_agent: unknown, category: string) => { rewound.push(category); return 1; };
        try {
          exhausted.fw.noteInferenceExhausted('cairn', text, false, 'invalid_request');
        } finally { exhausted.restore(); }
        assertCut(text, exhausted.markers[0].meta.reason, 600, where('[inference-failed] marker'));
        assertCut(text, exhausted.logged[0].reason as string, 2_000, where('failures.log'));
        assertCut(text, exhausted.fw.lastInferenceAt.get('cairn').lastError, 300, where('lastError'));
        assertCut(text, rewound[0], 160, where('rewind marker'));
        const hardDown = exhausted.traces.find((t) => t.type === 'ops:alert' && t.kind === 'hard-down').message as string;
        const prefix = '1 consecutive inference failures. Last reason: ';
        assert.ok(hardDown.startsWith(prefix), where('hard-down alert'));
        assertCut(text, hardDown.slice(prefix.length), 2_000 - prefix.length, where('hard-down alert'));

        // A refused compile: the context-refusal alert (no drain kick here).
        const refused = makeHarness();
        refused.fw.overBudgetDrainInFlight.add('cairn');
        try {
          refused.fw.noteInferenceExhausted('cairn', text, undefined, 'over_budget');
        } finally { refused.restore(); }
        const refusal = refused.traces.find((t) => t.type === 'ops:alert' && t.kind === 'context-refusal').message as string;
        assertCut(text, /^compile refused \(over_budget\): ([\s\S]*) — drain breaker/.exec(refusal)![1], 300, where('compile-refused alert'));

        // An alert's message, posted to the ops webhook.
        const alerted = makeHarness();
        try {
          alerted.fw.opsAlert('zz-webhook', 'cairn', text);
        } finally { alerted.restore(); }
        const webhook = '\u{1F6A8} **cairn** zz-webhook: ';
        const content = posted.find((c) => c.startsWith(webhook));
        assert.ok(content, where('webhook'));
        assertCut(text, content.slice(webhook.length), 500, where('webhook'));
      }
    }
  } finally {
    globalThis.fetch = realFetch;
    if (hook === undefined) delete process.env.CONNECTOME_OPS_WEBHOOK;
    else process.env.CONNECTOME_OPS_WEBHOOK = hook;
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
  assert.ok(unclassified.ticks() > 0, 'the unclassified phrase kicks the drain');

  // ...decided on the whole reason, even where the excerpts omit the phrase.
  const long = makeHarness();
  try {
    long.fw.noteInferenceExhausted('cairn', `${'x'.repeat(50_000)} Context would exceed hard budget ${'y'.repeat(50_000)}`);
    await settle();
  } finally { long.restore(); }
  assert.equal(long.ticks(), unclassified.ticks(), 'presentation bounds never change the decision');
});

test('a reason that is not a string is described whole, not thrown on: each sink cuts it once, and the fallback reads it uncut', async () => {
  // Unreachable from the stream paths, which pass a message; a malformed
  // trace event must still leave its failure record.
  const error = new Error(`zz-not-a-string ${echo()}`);
  const { fw, markers, logged, restore } = makeHarness();
  try {
    fw.noteInferenceExhausted('cairn', error);
  } finally { restore(); }
  const whole = `Error: ${error.message}`;
  assertCut(whole, markers[0].meta.reason, 600, 'marker');
  assert.equal(markers[0].meta.reasonChars, whole.length);
  assertCut(whole, logged[0].reason as string, 2_000, 'failures.log');
  assert.equal(logged[0].reasonChars, whole.length);

  // The OverBudget fallback reads the whole description, so a phrase that
  // every excerpt omits still kicks the drain.
  const phrased = makeHarness();
  try {
    phrased.fw.noteInferenceExhausted('cairn', new Error(`${'x'.repeat(50_000)} Context would exceed hard budget ${'y'.repeat(50_000)}`));
    await settle();
  } finally { phrased.restore(); }
  // The same drain a short reason with the phrase kicks.
  const short = makeHarness();
  try {
    short.fw.noteInferenceExhausted('cairn', new Error('Context would exceed hard budget'));
    await settle();
  } finally { short.restore(); }
  assert.ok(short.ticks() > 0);
  assert.equal(phrased.ticks(), short.ticks());
});

test("a caller's long error type is bounded wherever it is written", () => {
  // classifyInferenceError bounds the types it reads; a caller that passes
  // its own is bounded the same way.
  const { fw, markers, logged, errs, restore } = makeHarness();
  const type = `zz${'T'.repeat(MEGA)}`;
  try {
    fw.noteInferenceExhausted('cairn', 'zz-reason', false, type);
  } finally { restore(); }
  assertCut(type, markers[0].meta.errorType, 128, 'marker metadata');
  assertCut(type, logged[0].errorType as string, 128, 'failures.log');
  assert.ok(markers[0].text.length < 1_000, `marker text is ${markers[0].text.length} chars`);
  const line = errs.find((e) => e.startsWith('[inference-failed] agent=cairn'))!;
  assert.ok(line.length < 400, `stderr line is ${line.length} chars`);
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

/** Every argument a failure log passed is a bounded string: no object for the
 *  runtime to inspect. The projection and the stack frames below it are each
 *  bounded to 2,000 characters. */
function assertBoundedStrings(rawArgs: unknown[][], marker: string): string {
  const call = rawArgs.find((args) => typeof args[0] === 'string' && (args[0] as string).includes(marker));
  assert.ok(call, `a log line containing "${marker}"`);
  for (const arg of call!) assert.equal(typeof arg, 'string', `${marker}: an argument was a ${typeof arg}`);
  const line = call!.join(' ');
  assert.ok(line.length < 4_500, `${marker} line is ${line.length} chars`);
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
    // The frames follow the projection, so an internal throw still says where.
    assert.match(kick, /\n {4}at .*inference-failure-bounds\.test/);

    const refused = makeHarness({ addMessage: () => { throw error; } });
    try {
      refused.fw.noteInferenceExhausted('cairn', 'boom');
    } finally { refused.restore(); }
    assert.match(assertBoundedStrings(refused.rawArgs, 'could not record chronicle marker'), /\n {4}at .*inference-failure-bounds\.test/);
  }

  // A message's own lines can look like frames (an echoed request quoting a
  // stack trace): the frames are the stack's, after the message, so the throw
  // site is kept rather than spending the frames' bound on the message.
  const quoting = new Error(`tool output:\n    at zz-quoted (quoted.js:1:1)\n${echo()}`);
  const quoted = makeHarness({ tick: async () => { throw quoting; } });
  try {
    quoted.fw.noteInferenceExhausted('cairn', 'Context would exceed hard budget', undefined, 'over_budget');
    await settle();
  } finally { quoted.restore(); }
  const quotedLine = assertBoundedStrings(quoted.rawArgs, 'drain kick failed');
  assert.equal(quotedLine.split('zz-quoted').length - 1, 1, 'the quoted frame is in the projection only');
  assert.match(quotedLine, /\n {4}at .*inference-failure-bounds\.test/);

  // A stack without its header, as a copied one can be: the message's text
  // inside a frame's name isn't taken for the header, so the throw site stays.
  const requestHandler = (): Error => new Error('request');
  const headless = requestHandler();
  headless.stack = headless.stack!.split('\n').slice(1).join('\n');
  const bare = makeHarness({ tick: async () => { throw headless; } });
  try {
    bare.fw.noteInferenceExhausted('cairn', 'Context would exceed hard budget', undefined, 'over_budget');
    await settle();
  } finally { bare.restore(); }
  assert.match(assertBoundedStrings(bare.rawArgs, 'drain kick failed'), /\n {4}at requestHandler /);

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

/** The line a drain kick logs when the context manager's tick throws `thrown`. */
async function kickedWith(thrown: unknown): Promise<string> {
  const kicked = makeHarness({ tick: async () => { throw thrown; } });
  try {
    kicked.fw.noteInferenceExhausted('cairn', 'Context would exceed hard budget', undefined, 'over_budget');
    await settle();
  } finally { kicked.restore(); }
  return assertBoundedStrings(kicked.rawArgs, 'drain kick failed');
}

test("a thrown value that isn't an Error logs its own text, or its JSON when its text is only a tag", async () => {
  const prefix = '[inference-failed] drain kick failed for cairn after 0 ticks: ';
  class Refusal {
    readonly #why: string;
    constructor(why: string) { this.#why = why; }
    toString(): string { return `refused: ${this.#why}`; }
  }
  class Payload { code = 'zz_code'; detail = 'zz-detail'; }
  const cyclic: Record<string, unknown> = { zz: 1 };
  cyclic.self = cyclic;
  const cases: Array<[string, unknown, string]> = [
    ['a class with its own toString', new Refusal('zz-quota'), 'refused: zz-quota'],
    ['a Buffer', Buffer.from('zz-buffer text'), 'zz-buffer text'],
    ['an Error from another realm', vm.runInNewContext("new Error('zz-realm')"), 'Error: zz-realm'],
    ['a plain object', { code: 'zz_plain', count: 1 }, '{"code":"zz_plain","count":1}'],
    ['a class instance without toString', new Payload(), '{"code":"zz_code","detail":"zz-detail"}'],
    // An array's String joins its elements' Strings; its JSON keeps them.
    ['an array', [{ code: 'zz_a' }, new Error('zz-item')], '[{"code":"zz_a"},"Error: zz-item"]'],
    ['an empty array', [], '[]'],
    ['an object with no String of its own', Object.assign(Object.create(null), { code: 'zz_bare' }), '{"code":"zz_bare"}'],
    ['an object JSON cannot write', cyclic, '[object Object]'],
    ['an object with no fields but its tag', { [Symbol.toStringTag]: 'ZzTagged' }, '[object ZzTagged]'],
    ['an object whose String is empty', { toString: () => '' }, '[object Object]'],
    ['an object with neither a String nor fields', Object.create(null), '[object Object]'],
    ['an object whose JSON is nothing', { toJSON: () => undefined }, '[object Object]'],
  ];
  for (const [what, thrown, logged] of cases) {
    assert.equal(await kickedWith(thrown), `${prefix}${logged}`, what);
  }
});

test("a failure's frames: cut to their bound, and from the stack's first frame line when the message isn't its header", async () => {
  const prefix = '[inference-failed] drain kick failed for cairn after 0 ticks: ';
  const framesOf = (stack: string) => stack.slice(stack.search(/^[ \t]+at /m));

  // A stack far past the bound: its frames are cut by the one rule.
  const deep = new Error('zz-deep');
  const deepStack = `Error: zz-deep\n${Array.from({ length: 1_000 }, (_, i) => `    at zzFrame${i} (deep.js:${i + 1}:1)`).join('\n')}`;
  deep.stack = deepStack;
  const deepLine = await kickedWith(deep);
  const deepHead = `${prefix}Error: zz-deep\n`;
  assert.ok(deepLine.startsWith(deepHead));
  assertCut(framesOf(deepStack), deepLine.slice(deepHead.length), 2_000, 'the frames of a deep stack');

  // A message that isn't in the stack (replaced after the stack was taken),
  // and an empty message: the frames are the stack's from its first frame line.
  const replaced = new Error('zz-original');
  const replacedStack = 'Error: zz-original\n    at zzThrower (replaced.js:1:1)\n    at zzCaller (replaced.js:2:1)';
  replaced.stack = replacedStack;
  replaced.message = `zz-replaced ${'r'.repeat(300)}`;
  assert.equal(await kickedWith(replaced), `${prefix}Error: ${replaced.message}\n${framesOf(replacedStack)}`);
  const empty = new Error('');
  empty.stack = 'Error\n    at zzThrower (empty.js:1:1)';
  assert.equal(await kickedWith(empty), `${prefix}Error: \n    at zzThrower (empty.js:1:1)`);

  // A message that ends in blank lines: the frames start at the frame line,
  // since a frame's indent is spaces or tabs and never crosses a line break
  // (an indent that did made a run of blank lines quadratic to scan).
  const blank = new Error('zz-blank\n\n');
  blank.stack = 'Error: zz-blank\n\n\n    at zzThrower (blank.js:1:1)';
  assert.equal(await kickedWith(blank), `${prefix}Error: zz-blank\n\n\n    at zzThrower (blank.js:1:1)`);
});

test('a thrown non-Error, and an error whose projection throws, still log bounded lines', async () => {
  const thrownString = makeHarness({ tick: async () => { throw `socket said: ${echo()}`; } });
  try {
    thrownString.fw.noteInferenceExhausted('cairn', 'Context would exceed hard budget', undefined, 'over_budget');
    await settle();
  } finally { thrownString.restore(); }
  const line = assertBoundedStrings(thrownString.rawArgs, 'drain kick failed');
  assert.match(line, /after 0 ticks: socket said: zz-head e+ …\[\d+ of \d+ characters omitted\]… e+ zz-tail$/);

  // A name getter that throws breaks the projection and the stack alike.
  const hostile = new Error('zz-short');
  Object.defineProperty(hostile, 'name', { get() { throw new Error('zz-no-name'); } });
  const unprintable = makeHarness({ tick: async () => { throw hostile; } });
  try {
    unprintable.fw.noteInferenceExhausted('cairn', 'Context would exceed hard budget', undefined, 'over_budget');
    await settle();
  } finally { unprintable.restore(); }
  assert.match(assertBoundedStrings(unprintable.rawArgs, 'drain kick failed'), /after 0 ticks: \[failure could not be described\]$/);
});

test('a provider hold keeps a bounded reason, and a failed resume logs the bounded projection', async () => {
  const providerState = (fw: any) => Object.assign(fw, {
    ephemeralRuns: new Map(), registry: { ownsProviderScheduling: () => true, homeChannel: () => undefined }, providerGates: new Map(),
    providerAccelerationCooldowns: new Map(), providerAccelerationRecoveries: new Map(),
    providerAdmissionClosed: false, activeTurnTokens: new Map(), quiesced: false, deadlineCuts: new Map(),
  });
  const held = makeHarness();
  providerState(held.fw);
  const agent = held.fw.agents.get('cairn');
  try {
    // A host hold with no reason of its own: the error's message stands in.
    held.fw.providerHoldHook = () => ({ holdMs: 60_000 });
    assert.equal(held.fw.holdProviderAcceleration(agent, hugeProviderError()), true);
    const cooldown = held.fw.providerAccelerationCooldowns.get('cairn');
    assert.ok(cooldown.reason.length <= 2_000, `cooldown reason is ${cooldown.reason.length} chars`);
    assert.match(cooldown.reason, /^Bad request: zz-head/);
    assert.ok(held.fw.providerAccelerationRecoveries.get('cairn').reason.length <= 2_000);
    const holdLine = held.errs.find((e) => e.startsWith('[provider-cooldown] agent=cairn host hold ('));
    assert.ok(holdLine && holdLine.length < 2_300, `hold line is ${holdLine?.length} chars`);

    // A reason of the host's own is bounded too, here when a slice is extended.
    held.fw.providerHoldHook = () => ({ holdMs: 60_000, reason: `host says ${echo()}` });
    assert.equal(held.fw.extendHostProviderHold('cairn', cooldown), true);
    assert.ok(cooldown.reason.length <= 2_000);
    assert.match(cooldown.reason, /^host says zz-head/);
    const extended = held.errs.find((e) => e.includes('host hold extended'));
    assert.ok(extended && extended.length < 2_300, `extension line is ${extended?.length} chars`);
  } finally {
    held.fw.cancelProviderAdmission();
    held.restore();
  }

  // A hook is handed the model's error, and one that throws it back logs its
  // projection, never the object with its request.
  const threw = makeHarness();
  providerState(threw.fw);
  try {
    threw.fw.providerHoldHook = (error: Error) => { throw error; };
    assert.equal(threw.fw.holdProviderAcceleration(threw.fw.agents.get('cairn'), hugeProviderError()), false);
  } finally { threw.restore(); }
  const threwLine = assertBoundedStrings(threw.rawArgs, 'providerHold hook threw');
  assert.match(threwLine, /treating as no hold: MembraneError \(invalid_request, HTTP 400, zz_bad_request, retryable=false\): Bad request: zz-head/);
  assert.match(threwLine, /\n {4}at /);

  // One that throws a plain object logs its JSON, bounded, so the fields that
  // printing the object showed are kept.
  const thrown = { code: 'zz_hold', detail: echo() };
  const plain = makeHarness();
  providerState(plain.fw);
  try {
    plain.fw.providerHoldHook = () => { throw thrown; };
    assert.equal(plain.fw.holdProviderAcceleration(plain.fw.agents.get('cairn'), hugeProviderError()), false);
  } finally { plain.restore(); }
  const plainLine = assertBoundedStrings(plain.rawArgs, 'providerHold hook threw');
  const noHold = 'treating as no hold: ';
  assertCut(JSON.stringify(thrown), plainLine.slice(plainLine.indexOf(noHold) + noHold.length), 2_000, 'a thrown plain object');

  // The built-in acceleration cooldown keeps the error's own message as its reason.
  const accelerated = makeHarness();
  providerState(accelerated.fw);
  Object.assign(accelerated.fw, { providerAccelerationDefaultCooldownMs: 30_000, providerAccelerationJitterMs: 0 });
  try {
    const limited = new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429, rawError: { status: 429 },
      message: `Your organization has hit its acceleration limit. ${echo()}`,
    });
    assert.equal(accelerated.fw.holdProviderAcceleration(accelerated.fw.agents.get('cairn'), limited), true);
    const reason = accelerated.fw.providerAccelerationCooldowns.get('cairn').reason;
    assert.ok(reason.length <= 2_000, `acceleration cooldown reason is ${reason.length} chars`);
    assert.match(reason, /^Your organization has hit its acceleration limit\. zz-head/);
  } finally {
    accelerated.fw.cancelProviderAdmission();
    accelerated.restore();
  }

  // Resuming the primary after the auxiliary call drains, and failing.
  const resumed = makeHarness();
  providerState(resumed.fw);
  resumed.fw.providerGates.set('cairn', {
    primaryDepth: 0, primaryPending: false, auxiliaryInFlight: 1, auxiliaryWaiters: [], idleWaiters: [], deferredAuxiliary: 0,
  });
  resumed.fw.waitForAuxiliaryIdle = async () => {};
  resumed.fw.startAgentStream = async () => { throw hugeProviderError(); };
  try {
    await (FrameworkClass.prototype as any).startAgentStream.call(resumed.fw, resumed.fw.agents.get('cairn'));
    await settle();
  } finally { resumed.restore(); }
  const line = assertBoundedStrings(resumed.rawArgs, 'failed to resume primary');
  assert.match(line, /failed to resume primary for cairn: MembraneError \(invalid_request, HTTP 400, zz_bad_request, retryable=false\): Bad request: zz-head/);
  assert.match(line, /\n {4}at /);
});

/** Runs `body` with the ops webhook set and fetch stubbed; returns what it posted. */
async function withWebhook(body: () => Promise<void> | void): Promise<string[]> {
  const hook = process.env.CONNECTOME_OPS_WEBHOOK;
  const realFetch = globalThis.fetch;
  const posted: string[] = [];
  process.env.CONNECTOME_OPS_WEBHOOK = 'http://zz.invalid/hook';
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    posted.push(JSON.parse(String(init?.body)).content);
    return new Response(null);
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
    if (hook === undefined) delete process.env.CONNECTOME_OPS_WEBHOOK;
    else process.env.CONNECTOME_OPS_WEBHOOK = hook;
  }
  return posted;
}

test('a failed maintenance pass logs and alerts a bounded reason', async () => {
  const { fw, traces, rawArgs, restore } = makeHarness();
  fw.running = true;
  fw.maintenancePass = null;
  const error = hugeProviderError();
  fw.runQueuedMaintenance = async () => { throw error; };
  const posted = await withWebhook(async () => {
    try {
      fw.startQueuedMaintenance();
      await settle();
    } finally { restore(); }
  });
  assert.match(assertBoundedStrings(rawArgs, '[context-maintenance] pass failed:'), /pass failed: Bad request: zz-head/);
  const alert = traces.find((t) => t.type === 'ops:alert' && t.kind === 'context-maintenance-failed');
  assert.ok(alert && alert.message.length <= 2_000);
  assert.deepEqual(alert.data, { scope: 'pass' });
  // The webhook's copy is cut from the whole message, so it states its length.
  const webhook = '\u{1F6A8} **framework** context-maintenance-failed: ';
  assert.ok(posted[0]?.startsWith(webhook), posted[0]?.slice(0, 80));
  assertCut(error.message, posted[0].slice(webhook.length), 500, 'maintenance webhook');

  // A thrown value that isn't an Error is described as the other logs
  // describe one, with no String() to throw on it.
  const bare = makeHarness();
  bare.fw.running = true;
  bare.fw.maintenancePass = null;
  bare.fw.runQueuedMaintenance = async () => { throw Object.assign(Object.create(null), { code: 'zz_bare' }); };
  try {
    bare.fw.startQueuedMaintenance();
    await settle();
  } finally { bare.restore(); }
  assert.match(assertBoundedStrings(bare.rawArgs, '[context-maintenance] pass failed:'), /pass failed: \{"code":"zz_bare"\}$/);
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

test('alert data of null, from a JavaScript caller, is no data: the alert is still logged and traced', () => {
  const { fw, traces, logged, restore } = makeHarness();
  try {
    fw.notifyOpsAlert('zz-detector', 'cairn', 'short message', null);
  } finally { restore(); }
  assert.equal(traces.find((t) => t.type === 'ops:alert')?.message, 'short message');
  assert.deepEqual(logged, [{ agent: 'cairn', kind: 'zz-detector', reason: 'short message' }]);
});

test('an alert message that is not a string, from a JavaScript caller, is described as a thrown value is', async () => {
  const { fw, traces, logged, restore } = makeHarness();
  const posted = await withWebhook(() => {
    try {
      fw.notifyOpsAlert('zz-untyped', 'cairn', undefined, { count: 1 });
      // One with no String of its own, which String() throws on.
      fw.notifyOpsAlert('zz-bare', 'cairn', Object.assign(Object.create(null), { code: 'zz_bare' }));
    } finally { restore(); }
  });
  assert.deepEqual(traces.filter((t) => t.type === 'ops:alert').map((t) => t.message), ['undefined', '{"code":"zz_bare"}']);
  assert.deepEqual(logged, [
    { agent: 'cairn', kind: 'zz-untyped', reason: 'undefined', count: 1 },
    { agent: 'cairn', kind: 'zz-bare', reason: '{"code":"zz_bare"}' },
  ]);
  assert.deepEqual(posted, ['\u{1F6A8} **cairn** zz-untyped: undefined', '\u{1F6A8} **cairn** zz-bare: {"code":"zz_bare"}']);
});

test('alert data that is not a plain object is one bounded field, not a field per character or element', () => {
  const { fw, traces, logged, restore } = makeHarness();
  const text = echo(10_000);
  const list = Array.from({ length: 2_000 }, (_, i) => i);
  try {
    // From a JavaScript caller: bounded field by field, a string or an array
    // would spread into a field per character or element.
    fw.notifyOpsAlert('zz-string', 'cairn', 'short message', text);
    fw.notifyOpsAlert('zz-array', 'cairn', 'short message', list);
    fw.notifyOpsAlert('zz-small', 'cairn', 'short message', [1, 2]);
    // Only a plain object's fields are spread: a class instance is kept whole
    // as its JSON, and an object with a null prototype is a plain record.
    fw.notifyOpsAlert('zz-instance', 'cairn', 'short message', new (class ZzPayload { channel = 'zz-channel'; })());
    fw.notifyOpsAlert('zz-record', 'cairn', 'short message', Object.assign(Object.create(null), { channel: 'zz-channel' }));
  } finally { restore(); }
  const [stringAlert, arrayAlert, smallAlert, instanceAlert, recordAlert] = traces.filter((t) => t.type === 'ops:alert');
  assert.deepEqual(instanceAlert.data, { data: { channel: 'zz-channel' } });
  assert.deepEqual(logged[3], { agent: 'cairn', kind: 'zz-instance', reason: 'short message', data: { channel: 'zz-channel' } });
  assert.deepEqual({ ...recordAlert.data }, { channel: 'zz-channel' });
  assert.deepEqual(logged[4], { agent: 'cairn', kind: 'zz-record', reason: 'short message', channel: 'zz-channel' });
  // The trace carries what the record gets, bounded once.
  assert.equal(Object.keys(stringAlert.data).length, 1, "string data's fields");
  assertCut(text, stringAlert.data.data, 2_000, 'string data');
  assert.equal(Object.keys(arrayAlert.data).length, 1, "array data's fields");
  assertCut(JSON.stringify(list), arrayAlert.data.data, 2_000, 'array data');
  assert.deepEqual(smallAlert.data, { data: [1, 2] });
  assert.deepEqual(logged[2], { agent: 'cairn', kind: 'zz-small', reason: 'short message', data: [1, 2] });
});

/** The projection's head for hugeProviderError(), before ': ' and the message. */
const HUGE_ERROR_HEAD = 'MembraneError (invalid_request, HTTP 400, zz_bad_request, retryable=false)';

test('alert data is bounded field by field on the trace', () => {
  const { fw, traces, logged, restore } = makeHarness();
  const nested = { items: Array.from({ length: 2_000 }, (_, i) => ({ i, note: 'zz' })) };
  const text = echo();
  const error = hugeProviderError();
  try {
    fw.notifyOpsAlert('zz-detector', 'cairn', 'short message', {
      text, error, nested, count: 3, small: { a: 1 },
      // Small JSON, large value: the listener gets the JSON's data, not the value.
      held: new Map([['zz', echo()]]), at: new Date(0),
      // An Error inside a value is its projection too, in an array as well.
      wrapped: { cause: new Error('zz-small'), list: [new Error('zz-item')] },
      // A value JSON writes nothing for is left out, as the log's JSON leaves it out.
      callback: () => 'zz',
    });
  } finally { restore(); }
  const alert = traces.find((t) => t.type === 'ops:alert');
  for (const [sink, fields] of [['trace', alert.data]] as const) {
    assertCut(text, fields.text, 2_000, `${sink}: text`);
    // An Error is its projection: serialising it would write its rawRequest.
    // It is cut once, so its marker states the head and the whole message.
    assertCut(`${HUGE_ERROR_HEAD}: ${error.message}`, fields.error, 2_000, `${sink}: error`);
    assert.deepEqual(fields.wrapped, { cause: 'Error: zz-small', list: ['Error: zz-item'] }, `${sink}: nested Errors`);
    assert.equal('callback' in fields, false, `${sink}: a function is left out`);
    // A value whose JSON is too long becomes its JSON, bounded.
    assert.equal(typeof fields.nested, 'string', `${sink}: nested`);
    assert.ok(fields.nested.length <= 2_000 && fields.nested.startsWith('{"items":[{"i":0,'), `${sink}: nested`);
    // Small values are what their JSON describes.
    assert.equal(fields.count, 3);
    assert.deepEqual(fields.small, { a: 1 });
    assert.deepEqual(fields.held, {}, `${sink}: a Map is its JSON's data`);
    assert.equal(fields.at, '1970-01-01T00:00:00.000Z', `${sink}: a Date is its JSON's data`);
  }
});

test('logFailure bounds every field it writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-failure-bounds-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const fw = Object.create(FrameworkClass.prototype) as any;
    const circular: Record<string, unknown> = { zz: 1 };
    circular.self = circular;
    const reason = echo();
    const note = `zz-note ${echo(5_000)}`;
    const error = hugeProviderError();
    fw.logFailure({
      agent: 'cairn', reason, note, consecutive: 1,
      error, nested: { list: Array.from({ length: 2_000 }, (_, i) => i) }, circular,
      wrapped: { cause: error },
    });
    const line = readFileSync(join(dir, 'logs', 'failures.log'), 'utf-8').trim();
    assert.ok(line.length < 11_000, `failures.log line is ${line.length} chars`);
    const record = JSON.parse(line);
    // The written record, not what a caller passed: each string is cut by the one rule.
    assertCut(reason, record.reason, 2_000, 'failures.log reason');
    assertCut(note, record.note, 2_000, 'failures.log note');
    assert.equal(record.consecutive, 1);
    assertCut(`${HUGE_ERROR_HEAD}: ${error.message}`, record.error, 2_000, 'failures.log error');
    assert.ok(typeof record.nested === 'string' && record.nested.length <= 2_000);
    // An Error inside a value is written as its whole projection, not its own
    // fields with the request, and the value's JSON is cut once.
    assertCut(JSON.stringify({ cause: `${HUGE_ERROR_HEAD}: ${error.message}` }), record.wrapped, 2_000, 'failures.log wrapped');
    // A value JSON can't write no longer loses the whole record.
    assert.equal(record.circular, '[object Object]');
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

/** A console.error spy that keeps the arguments as passed: printing an object
 *  (rather than a string built from it) is what wrote a MembraneError's whole
 *  rawRequest to stderr, and String() of the argument would hide it. */
function spyConsoleError() {
  const errs: string[] = [];
  const rawArgs: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { rawArgs.push(a); errs.push(a.map(String).join(' ')); };
  return { errs, rawArgs, restore: () => { console.error = orig; } };
}

/** No failure log printed an object: every argument of every line was a string. */
function assertNoObjectPrinted(rawArgs: unknown[][]): void {
  for (const args of rawArgs) {
    for (const arg of args) assert.equal(typeof arg, 'string', `${String(args[0]).slice(0, 80)}: an argument was a ${typeof arg}`);
  }
}

/** Never retries, so a test reaches exhaustion on the first failure. */
const noRetry: ErrorPolicy = { maxRetries: 0, onInferenceError: () => ({ retry: false }) };

async function runFailingTurn(path: Path, make: (request: NormalizedRequest) => Error, opts?: { errorPolicy?: ErrorPolicy; turns?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'af-failure-bounds-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const { errs, rawArgs, restore } = spyConsoleError();
  const membrane = new FailingMembrane(path, make);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system' }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    ...(opts?.errorPolicy ? { errorPolicy: opts.errorPolicy } : {}),
  });
  const traces: any[] = [];
  framework.onTrace((e) => traces.push(e));
  try {
    for (let turn = 0; turn < (opts?.turns ?? 1); turn++) {
      framework.pushEvent({ type: 'external-message', source: 'test', content: `hello ${turn}`, metadata: {} });
      await framework.runUntilIdle();
    }
    const messages = framework.getAgent('resident')!.getContextManager().queryMessages({}).messages;
    const markers = messages.filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'inference-failed');
    const failuresLog = existsSync(join(dir, 'logs', 'failures.log')) ? readFileSync(join(dir, 'logs', 'failures.log'), 'utf-8') : '';
    const inferenceLogs = framework.queryInferenceLogs({}).entries;
    return { messages, markers, traces, errs, rawArgs, failuresLog, inferenceLogs, calls: membrane.calls.length };
  } finally {
    await framework.stop();
    restore();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const path of ['stream error event', 'stream throws', 'stream setup throws'] as const) {
  test(`${path}: a ~1 MB provider error leaves a bounded, classified trail`, async () => {
    const { markers, traces, errs, rawArgs, failuresLog, inferenceLogs } = await runFailingTurn(path, (request) => hugeProviderError(request));
    assertNoObjectPrinted(rawArgs);
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
  const { markers, errs, rawArgs } = await runFailingTurn('stream throws', () => new Error(`socket said: ${echo()}`));
  assertNoObjectPrinted(rawArgs);
  assert.equal(markers.length, 1);
  const text = (markers[0].content[0] as { text: string }).text;
  assert.ok(text.length < 1_200);
  assert.match(text, /model call failed and produced no response/);
  const longest = errs.reduce((max, e) => Math.max(max, e.length), 0);
  assert.ok(longest < 4_500, `longest stderr line is ${longest} chars`);
});

test('an oversized provider code is bounded in the trace, the marker and failures.log', async () => {
  const { markers, traces, failuresLog } = await runFailingTurn('stream error event', () => new MembraneError({
    type: 'invalid_request', retryable: false, httpStatus: 400, providerErrorCode: `zz${'C'.repeat(MEGA)}`,
    message: 'Bad request: zz-short', rawError: { status: 400 },
  }));
  const exhausted = traces.find((t) => t.type === 'inference:exhausted');
  assert.ok(exhausted.providerErrorCode.length <= 128, `trace code is ${exhausted.providerErrorCode.length} chars`);
  assert.ok((markers[0].metadata as { providerErrorCode: string }).providerErrorCode.length <= 128);
  const record = failuresLog.trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.kind === 'inference-exhausted');
  assert.ok(record.providerErrorCode.length <= 128, `failures.log code is ${record.providerErrorCode.length} chars`);
});

/** A MembraneError built by another copy of the package: the same fields and name, another class. */
function foreignMembraneError(message: string, type = 'invalid_request'): Error {
  return Object.assign(new Error(message), {
    name: 'MembraneError', type, retryable: false, httpStatus: 400, providerErrorCode: 'zz_bad_request', rawRequest: { system: echo() },
  });
}

test('a MembraneError from another copy of membrane is recognised by its name', async () => {
  const quoted = `Bad request. Request: ... Context would exceed hard budget ... ${echo(10_000)}`;
  // The default error policy, which a stream's error event consults: a
  // non-retryable error fails at once, not after three retries.
  const { markers, traces, errs, rawArgs, calls } = await runFailingTurn('stream error event', () => foreignMembraneError(quoted));
  assert.equal(calls, 1, 'not retried');
  assert.match((markers[0].content[0] as { text: string }).text, /model call failed \(invalid_request, HTTP 400\)/);
  assert.equal((markers[0].metadata as { errorType: string }).errorType, 'invalid_request');
  // Classified, so the quoted phrase is the provider's text, not a refused compile.
  assert.equal(traces.filter((t) => t.type === 'ops:alert' && t.kind === 'context-refusal').length, 0);
  assert.equal(errs.some((e) => e.includes('drain kicked')), false);
  assertNoObjectPrinted(rawArgs);

  // Classified, it gets the poisoned-history quarantine at the hard-down
  // threshold, as the framework's own copy does: the third failure sheds the
  // newest exchange, counted in the one rewind marker. Each shed queues a
  // retry on the rewound history, which may fail and shed again before the
  // run is stopped, so only the first shed is asserted.
  const shed = await runFailingTurn('stream error event', () => foreignMembraneError(quoted), { turns: 3 });
  const quarantined = shed.errs.filter((e) => e.startsWith('[inference-rewind] agent=resident auto-quarantined'));
  assert.ok(quarantined.length > 0, 'the third failure sheds');
  assert.match(quarantined[0], /\(1 turn\(s\) shed this episode, cap 3\)/);
  const kept = shed.messages.filter((m) => !(m.metadata as { system?: unknown } | undefined)?.system)
    .map((m) => (m.content[0] as { text: string }).text);
  assert.ok(!kept.includes('hello 2'), 'the newest exchange is shed');
  const rewind = shed.messages.filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'refusal-rewind');
  assert.equal(rewind.length, 1, 'one consolidated rewind marker');
  assert.match((rewind[0].content[0] as { text: string }).text, /^\[refusal-rewind\] The \d+ most recent turn\(s\) were set aside/);

  // Its type is bounded like a provider code, in every sink it reaches.
  const odd = await runFailingTurn('stream throws', () => foreignMembraneError('Bad request: zz-short', `zz${'T'.repeat(MEGA)}`), { errorPolicy: noRetry });
  const exhausted = odd.traces.find((t) => t.type === 'inference:exhausted');
  assert.ok(exhausted.errorType.length <= 128, `trace type is ${exhausted.errorType.length} chars`);
  assert.ok((odd.markers[0].metadata as { errorType: string }).errorType.length <= 128);
  const line = odd.errs.find((e) => e.startsWith('[inference-failed] agent=resident'))!;
  assert.ok(line.length < 2_500, `stderr line is ${line.length} chars`);

  // The organization acceleration limit is recognised too, and held.
  const harness = makeHarness();
  Object.assign(harness.fw, {
    ephemeralRuns: new Map(), registry: { ownsProviderScheduling: () => true, homeChannel: () => undefined }, providerGates: new Map(),
    providerAccelerationCooldowns: new Map(), providerAccelerationRecoveries: new Map(),
    providerAccelerationDefaultCooldownMs: 30_000, providerAccelerationJitterMs: 0,
  });
  const limited = Object.assign(new Error('Your organization has hit its acceleration limit.'), {
    name: 'MembraneError', type: 'rate_limit', retryable: true, httpStatus: 429,
  });
  try {
    assert.equal(harness.fw.holdProviderAcceleration(harness.fw.agents.get('cairn'), limited), true);
  } finally {
    harness.fw.cancelProviderAdmission();
    harness.restore();
  }
});

test("the default error policy reads either copy's retryable and retryAfterMs", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-failure-bounds-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: new FailingMembrane('stream setup throws', () => hugeProviderError()).asMembrane(),
    agents: [], modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  try {
    // The policy the framework built for itself, with no errorPolicy configured.
    const policy = (framework as any).errorPolicy as ErrorPolicy;
    const foreign = (fields: Record<string, unknown>) => Object.assign(new Error('Rate limited'), {
      name: 'MembraneError', type: 'rate_limit', httpStatus: 429, ...fields,
    });
    const own = new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 1234, message: 'Rate limited', rawError: { status: 429 },
    });
    // A stated wait is honoured, from another copy as from the framework's own.
    assert.deepEqual(policy.onInferenceError(own, 'resident', 0), { retry: true, delayMs: 1234 });
    assert.deepEqual(policy.onInferenceError(foreign({ retryable: true, retryAfterMs: 1234 }), 'resident', 0), { retry: true, delayMs: 1234 });
    // Without retryable, it retries as an unknown error does; refused only when false.
    assert.deepEqual(policy.onInferenceError(foreign({}), 'resident', 0), { retry: true, delayMs: 1_000 });
    assert.deepEqual(policy.onInferenceError(foreign({ retryable: false, retryAfterMs: 1234 }), 'resident', 0), { retry: false });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the breaker reads the status a real failure carries: a 404 never sheds; a 400, a 413 under either label and no status do', async () => {
  // Through classifyInferenceError, the inference:exhausted trace and
  // noteInferenceExhausted to the gate, three failed turns each: the
  // escalation threshold. A shed is read from its own line, since the cap's
  // and nothing-left-to-shed's lines share its prefix.
  const legs = [
    ['invalid_request', 404, false], ['invalid_request', 400, true], ['invalid_request', 413, true],
    ['context_length', 413, true], ['invalid_request', undefined, true],
  ] as const;
  for (const [type, status, sheds] of legs) {
    const label = `${type} ${status === undefined ? 'with no status' : `at ${status}`}`;
    const { errs, traces, messages, markers, failuresLog } = await runFailingTurn('stream error event', () => new MembraneError({
      type, retryable: false, message: `zz-${label}`, rawError: { status },
      ...(status === undefined ? {} : { httpStatus: status }),
    }), { turns: 3 });
    const exhausted = traces.filter((t) => t.type === 'inference:exhausted');
    assert.ok(exhausted.length >= 3, `${label}: ${exhausted.length} exhausted traces`);
    // The status as the failure carried it: none is invented for an error without one.
    assert.ok(exhausted.every((t) => t.httpStatus === status), `${label} reached the trace as it was`);
    assert.ok(errs.some((e) => e.startsWith('[inference-hard-down] agent=resident')), `${label} is reported hard-down`);
    const shed = errs.filter((e) => e.startsWith('[inference-rewind] agent=resident auto-quarantined'));
    const kept = messages.filter((m) => !(m.metadata as { system?: unknown } | undefined)?.system)
      .map((m) => (m.content[0] as { text: string }).text);
    if (sheds) {
      assert.ok(shed.length > 0, `${label} sheds`);
      assert.ok(!kept.includes('hello 2'), `${label}: the newest exchange is shed`);
    } else {
      assert.equal(shed.length, 0, `${label} sheds nothing`);
      assert.deepEqual(kept, ['hello 0', 'hello 1', 'hello 2'], `${label}: the history still holds every exchange`);
      // Only the shed is gated: each failure is still marked and logged.
      assert.equal(markers.length, 3, `${label}: an [inference-failed] marker per failure`);
      const records = failuresLog.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        .filter((record) => record.kind === 'inference-exhausted');
      assert.deepEqual(records.map((record) => record.httpStatus), [404, 404, 404], `${label}: a failures.log record per failure`);
    }
  }
});

test('an ephemeral run rejects with the bounded failure text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-failure-bounds-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const { restore } = spyConsoleError();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: new FailingMembrane('stream setup throws', () => hugeProviderError()).asMembrane(),
    agents: [], modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0, errorPolicy: noRetry,
  });
  try {
    const { agent, contextManager } = await framework.createEphemeralAgent({ name: 'worker', model: 'test-model', systemPrompt: 'Do the task.' });
    contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
    const run = framework.runEphemeralToCompletion(agent, contextManager);
    framework.start();
    await assert.rejects(run, (error: Error) => {
      assert.ok(error.message.length <= 2_000, `rejection message is ${error.message.length} chars`);
      assert.match(error.message, /^Bad request: zz-head e+ …\[\d+ of \d+ characters omitted\]… e+ zz-tail$/);
      return true;
    });
  } finally {
    await framework.stop();
    restore();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

class FailingStrategy implements ContextStrategy {
  readonly name = 'failing-maintenance-test';
  constructor(private readonly make: () => unknown) {}
  checkReadiness(): ReadinessState { return { ready: false, description: 'compression blocked' }; }
  async tick(_ctx: StrategyContext): Promise<void> { throw this.make(); }
  select(_store: MessageStoreView, _log: ContextLogView, _budget: TokenBudget): ContextEntry[] { return []; }
}

/** A real framework's first maintenance pass, its agent's tick throwing `make()`, with the ops webhook set. */
async function runFailingMaintenance(make: () => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'af-failure-bounds-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const { errs, rawArgs, restore } = spyConsoleError();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: new FailingStrategy(make) }],
    modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 10,
  });
  const traces: any[] = [];
  framework.onTrace((e) => traces.push(e));
  try {
    let record: any;
    const posted = await withWebhook(async () => {
      framework.start();
      const deadline = Date.now() + 5_000;
      while (framework.getContextMaintenanceSnapshot().history.length === 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      record = framework.getContextMaintenanceSnapshot().history[0].agents[0];
    });
    return { record, traces, errs, rawArgs, posted };
  } finally {
    await framework.stop();
    restore();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a ~1 MB maintenance failure: bounded record, ops alert and stderr', async () => {
  const error = hugeProviderError();
  const { record, traces, errs, rawArgs, posted } = await runFailingMaintenance(() => error);
  assert.ok(typeof record.error === 'string' && record.error.length <= 2_000, `maintenance record error is ${record.error?.length} chars`);
  assert.match(record.error, /^Bad request: zz-head/);
  const alert = traces.find((t) => t.type === 'ops:alert' && t.kind === 'context-maintenance-failed');
  assert.ok(alert && alert.message.length <= 2_000);
  const longest = errs.reduce((max, e) => Math.max(max, e.length), 0);
  assert.ok(longest < 4_500, `longest stderr line is ${longest} chars`);
  assertNoObjectPrinted(rawArgs);
  // The webhook's copy is cut from the whole message, so it states its length.
  const webhook = '\u{1F6A8} **agent** context-maintenance-failed: ';
  const content = posted.find((c) => c.startsWith(webhook));
  assert.ok(content, 'the webhook posted the alert');
  assertCut(error.message, content.slice(webhook.length), 500, 'maintenance webhook');

  // A thrown value that isn't an Error is described as the other logs describe one.
  const bare = await runFailingMaintenance(() => Object.assign(Object.create(null), { code: 'zz_bare' }));
  assert.equal(bare.record.error, '{"code":"zz_bare"}');
});

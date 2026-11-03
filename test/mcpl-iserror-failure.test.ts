/**
 * A server's error result (`isError: true`) is a failure on each path a tool
 * call takes: an in-process caller (`executeToolCall`,
 * `ModuleContext.callTool`, and the admin puppet, which calls through them)
 * gets the failure the model's call reads, and the traces of the model's call
 * and of a channel tool name it as `tool:failed`. A success is unchanged on
 * each path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/coalescing-fixture.js';
import { NON_STRING_TEXT_PLACEHOLDER } from '../src/mcpl/visible-content.js';
import type { ToolResult } from '../src/index.js';

const ANSWERS: Record<string, unknown> = {
  one: { isError: true, content: [{ type: 'text', text: 'no such row' }] },
  two: { isError: true, content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
  notString: { isError: true, content: [{ type: 'text', text: { a: 1 } }] },
  noText: { isError: true, content: [] },
  // Whitespace alone is no words, as a server's error answer reads it.
  blankText: { isError: true, content: [{ type: 'text', text: '  ' }, { type: 'text', text: '\n' }] },
  // Words with whitespace around them are the server's, as they came.
  padded: { isError: true, content: [{ type: 'text', text: '  no such row\n' }] },
  // A nonconformant server's: no content, or content that isn't a list.
  noContent: { isError: true },
  notList: { isError: true, content: 'not a list' },
  blank: { isError: true, content: [{ type: 'text', text: '' }, { type: 'text', text: 'after a blank' }] },
  image: { isError: true, content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }, { type: 'text', text: 'see the image' }] },
  ok: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
  okImage: { content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }, { type: 'text', text: 'caption' }] },
  okEmpty: { content: [] },
};

/** What an error answer with no text reads as. */
const NO_WORDS =
    'The "editor" server reported an error for mcpl--editor--lookup without saying what went wrong. ' +
    'Whether it did anything is unknown: check before calling it again.';

/** What each error answer reads as: its text, or NO_WORDS with none. */
const ERRORS: Record<string, string> = {
  one: 'no such row',
  two: 'first\nsecond',
  notString: NON_STRING_TEXT_PLACEHOLDER,
  noText: NO_WORDS,
  blankText: NO_WORDS,
  padded: '  no such row\n',
  noContent: NO_WORDS,
  notList: NO_WORDS,
  blank: 'after a blank',
  image: 'see the image',
};

type Trace = Record<string, unknown>;

async function setup(t: { after(fn: () => unknown): void }) {
  let ctx: { callTool(call: unknown): Promise<ToolResult> } | undefined;
  const probe = {
    name: 'probe',
    async start(c: typeof ctx) { ctx = c; },
    async stop() {},
    getTools() { return []; },
    async handleToolCall() { return { success: false, error: 'no tools', isError: true }; },
    async onProcess() { return {}; },
  };
  const f = await fixture({
    tools: [{ name: 'lookup', description: 'Look something up.', inputSchema: { type: 'object' } }],
    toolsCall: (params) => ANSWERS[(params.arguments as { case: string }).case],
    framework: { modules: [probe] } as never,
  });
  t.after(f.close);
  const traces: Trace[] = [];
  f.framework.onTrace((e) => { traces.push(e as unknown as Trace); });
  const internals = f.framework as unknown as { pushEvent(event: unknown): void; dispatchToolCall(agent: string, call: unknown): void };
  /** The result a model's call of `name` gets, as the framework pushes it. */
  const viaModel = (id: string, name: string, input: unknown) => new Promise<ToolResult>((resolve) => {
    const original = internals.pushEvent;
    internals.pushEvent = (event: unknown) => {
      const e = event as { type: string; callId?: string; result?: ToolResult };
      if (e.type === 'tool-result' && e.callId === id) { internals.pushEvent = original; resolve(e.result!); }
      else original.call(internals, event);
    };
    internals.dispatchToolCall('agent', { id, name, input });
  });
  /** A call's terminal trace events: its type, module and error. */
  const terminal = (id: string) => traces
    .filter((e) => e.callId === id && (e.type === 'tool:completed' || e.type === 'tool:failed'))
    .map((e) => ({ type: e.type, module: e.module, ...(e.error !== undefined ? { error: e.error } : {}) }));
  return { f, ctx: () => ctx!, traces, viaModel, terminal };
}

/** A result's four fields, so a field left out and one set to undefined compare alike. */
const fields = (r: ToolResult) => ({ success: r.success, data: r.data, error: r.error, isError: r.isError });

const lookup = (id: string, c: string) => ({ id, name: 'mcpl--editor--lookup', input: { case: c } });

test('a server\'s error reaches an in-process caller as the failure the model\'s call reads, its text joined, a text that isn\'t a string as the placeholder, and none as a failure whose effect is unknown', { timeout: 20_000 }, async (t) => {
  const { f, ctx, viaModel } = await setup(t);
  for (const [c, error] of Object.entries(ERRORS)) {
    const failure = { success: false, data: undefined, error, isError: true };
    assert.deepEqual(fields(await f.framework.executeToolCall(lookup(`x-${c}`, c))), failure, `executeToolCall, ${c}`);
    assert.deepEqual(fields(await ctx().callTool(lookup(`m-${c}`, c))), failure, `ModuleContext.callTool, ${c}`);
    assert.deepEqual(fields(await viaModel(`d-${c}`, 'mcpl--editor--lookup', { case: c })), failure, `the model's call, ${c}`);
  }
});

test('an in-process caller\'s success is still the server\'s own blocks, and the model\'s call still reads text as one string', { timeout: 20_000 }, async (t) => {
  const { f, ctx, viaModel } = await setup(t);
  const succeeded = (r: ToolResult) => ({ ...fields(r), isError: r.isError === true });
  const blocks = (ANSWERS.ok as { content: unknown[] }).content;
  assert.deepEqual(succeeded(await f.framework.executeToolCall(lookup('x-ok', 'ok'))), { success: true, data: blocks, error: undefined, isError: false });
  assert.deepEqual(succeeded(await ctx().callTool(lookup('m-ok', 'ok'))), { success: true, data: blocks, error: undefined, isError: false });
  const withImage = (ANSWERS.okImage as { content: unknown[] }).content;
  assert.deepEqual(succeeded(await f.framework.executeToolCall(lookup('x-okImage', 'okImage'))), { success: true, data: withImage, error: undefined, isError: false });
  assert.deepEqual(succeeded(await viaModel('d-ok', 'mcpl--editor--lookup', { case: 'ok' })), { success: true, data: 'a\nb', error: undefined, isError: false });
  assert.deepEqual(succeeded(await viaModel('d-okImage', 'mcpl--editor--lookup', { case: 'okImage' })), { success: true, data: withImage, error: undefined, isError: false });
  assert.deepEqual(succeeded(await f.framework.executeToolCall(lookup('x-okEmpty', 'okEmpty'))), { success: true, data: [], error: undefined, isError: false });
  assert.deepEqual(succeeded(await viaModel('d-okEmpty', 'mcpl--editor--lookup', { case: 'okEmpty' })), { success: true, data: undefined, error: undefined, isError: false });
});

test('the admin puppet stores a server\'s error as an error result, and traces it as one', { timeout: 20_000 }, async (t) => {
  const { f, traces } = await setup(t);
  const before = traces.length;
  const { toolUseId, result } = await f.framework.puppetToolCall('agent', 'mcpl--editor--lookup', { case: 'one' });
  assert.deepEqual(fields(result), { success: false, data: undefined, error: 'no such row', isError: true });
  const stored = f.framework.getAgent('agent')!.getContextManager().getAllMessages()
    .flatMap((m) => m.content as unknown as Array<Record<string, unknown>>)
    .find((b) => b.type === 'tool_result' && b.toolUseId === toolUseId);
  assert.ok(stored, 'the pair is stored');
  assert.equal(stored.isError, true);
  assert.equal(stored.content, 'no such row');
  assert.deepEqual(traces.slice(before).filter((e) => e.type === 'puppet:tool-call').map((e) => e.isError), [true]);
  // With no words, the puppet returns and stores the text the other paths read.
  const silent = await f.framework.puppetToolCall('agent', 'mcpl--editor--lookup', { case: 'noText' });
  assert.deepEqual(fields(silent.result), { success: false, data: undefined, error: NO_WORDS, isError: true });
  const storedSilent = f.framework.getAgent('agent')!.getContextManager().getAllMessages()
    .flatMap((m) => m.content as unknown as Array<Record<string, unknown>>)
    .find((b) => b.type === 'tool_result' && b.toolUseId === silent.toolUseId);
  assert.ok(storedSilent, 'the no-words pair is stored');
  assert.equal(storedSilent.isError, true);
  assert.equal(storedSilent.content, NO_WORDS);
});

test('a server\'s error through the model\'s call is traced as tool:failed with its error, and a success as tool:completed', { timeout: 20_000 }, async (t) => {
  const { viaModel, terminal } = await setup(t);
  await viaModel('d-one', 'mcpl--editor--lookup', { case: 'one' });
  assert.deepEqual(terminal('d-one'), [{ type: 'tool:failed', module: 'mcpl:editor', error: 'no such row' }]);
  await viaModel('d-noText', 'mcpl--editor--lookup', { case: 'noText' });
  assert.deepEqual(terminal('d-noText'), [{ type: 'tool:failed', module: 'mcpl:editor', error: NO_WORDS }]);
  await viaModel('d-ok', 'mcpl--editor--lookup', { case: 'ok' });
  assert.deepEqual(terminal('d-ok'), [{ type: 'tool:completed', module: 'mcpl:editor' }]);
});

test('a channel tool\'s error result is traced as tool:failed with its error, and a success as tool:completed', { timeout: 20_000 }, async (t) => {
  const { viaModel, terminal } = await setup(t);
  const refused = await viaModel('ch-open', 'channel_open', { channelId: 'nope' });
  assert.equal(refused.isError, true);
  assert.deepEqual(terminal('ch-open'), [{ type: 'tool:failed', module: 'channels', error: refused.error }]);
  assert.equal(typeof refused.error, 'string');
  const listed = await viaModel('ch-list', 'channel_list', {});
  assert.equal(listed.success, true);
  assert.deepEqual(terminal('ch-list'), [{ type: 'tool:completed', module: 'channels' }]);
});

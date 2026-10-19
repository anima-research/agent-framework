/**
 * A module runs in the host's process, so its tool can return what JSON can't
 * hold: a cyclic object, a BigInt, a toJSON that throws, no result object at
 * all, or one whose getters throw. Storing, sending or tracing such a result
 * threw, so the agent's turn never settled and stop() didn't return (#309). It
 * becomes an error result naming the tool. Every consumer gets a result's JSON
 * form, read once. A result with no data is a success with no output.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ScriptToolResult, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

function cyclic(): Record<string, unknown> {
  const loop: Record<string, unknown> = { label: 'loop' };
  loop.self = loop;
  return loop;
}

/** A result class whose data is a prototype getter, which JSON skips. */
class GetterResult {
  readonly success = true;
  get data(): unknown { return { from: 'getter' }; }
}

/** What each tool of the module returns. */
const RESULTS: Record<string, () => unknown> = {
  cyclic: () => ({ success: true, data: cyclic() }),
  bigint: () => ({ success: true, data: { count: 10n } }),
  // toJSON throws a value with no text form at all.
  tojson: () => ({ success: true, data: { toJSON() { throw Object.create(null); } } }),
  nodata: () => ({ success: true }),
  fn: () => ({ success: true, data: () => 1 }),
  errcyclic: () => ({ success: false, isError: true, error: 'Not found', data: cyclic() }),
  errobjcyclic: () => ({ success: false, isError: true, error: new Error('db timeout'), data: cyclic() }),
  objerror: () => ({ success: false, isError: true, error: { code: 'E42' } }),
  errerror: () => ({ success: false, isError: true, error: new Error('db timeout') }),
  nullerror: () => ({ success: false, isError: true, error: null }),
  quietfail: () => ({ success: false, error: 'unknown channel: c1', isError: false }),
  // An unflagged failure whose own text starts like an error.
  prefixquiet: () => ({ success: false, error: 'Error: quota is fine', isError: false }),
  noresult: () => undefined,
  nullresult: () => null,
  arrayresult: () => [],
  stringresult: () => 'done',
  throwsbare: () => { throw Object.create(null); },
  throwsempty: () => { throw new Error(); },
  falseerror: () => ({ success: false, isError: true, error: false }),
  emptyerror: () => ({ success: false, isError: true, error: '' }),
  objmsgerror: () => ({ success: false, isError: true, error: { message: 'socket closed', socket: cyclic() } }),
  fnerror: () => ({ success: false, isError: true, error: 'Not found', data: () => 1 }),
  returnserror: () => new Error('db timeout'),
  sym: () => ({ success: true, data: Symbol('s') }),
  emptyreason: () => ({ success: true, data: { toJSON() { throw new Error(''); } } }),
  bothtext: () => ({ success: true, data: { ok: 1 }, error: 'ignored' }),
  nulldataquiet: () => ({ success: false, error: 'gone', isError: false, data: null }),
  // endTurn as consumers read it: truthy, not only exactly true.
  endturn: () => ({ success: true, endTurn: 1, data: { count: 1n } }),
  plain: () => ({ success: true, data: { ok: true } }),
  // Consumers read a result's fields, never a toJSON of the result, so the
  // check doesn't either: not over a BigInt, and not for a form that isn't a
  // result object.
  resulttojson: () => ({ success: true, data: 1n, toJSON() { return { success: true, data: '1' }; } }),
  tojsonignored: () => ({ success: true, data: { kept: true }, toJSON() { return 'not a result'; } }),
  // A toJSON that answers once: consumers get what the check read.
  oncetojson: () => ({ success: true, data: { calls: 0, toJSON() { if (this.calls++ > 0) throw new Error('read twice'); return { once: true }; } } }),
  getterthrows: () => ({ success: true, get data() { throw Object.create(null); } }),
  messagethrows: () => ({
    success: false,
    isError: true,
    error: Object.defineProperty(new Error(), 'message', { get() { throw new Error('message unreadable'); } }),
  }),
  protogetter: () => new GetterResult(),
  datedata: () => ({ success: true, data: { at: new Date(0) } }),
  // Flags reach consumers as booleans, read for their truth, even one JSON
  // would leave out.
  flagsread: () => ({ success: 1, isError: 0, endTurn: 0, data: { ok: 1 } }),
  fnflag: () => ({ success: true, isError: () => true, error: 'flagged by a function', data: { ok: 1 } }),
  bigflag: () => ({ success: false, isError: 1n, error: 'flagged by a BigInt' }),
  // endTurn and the error's text are read before the data, so they're kept
  // when the data can't be read.
  endturngetter: () => ({ success: true, endTurn: true, get data() { throw new Error('gone'); } }),
  errgetter: () => ({ success: false, isError: true, error: 'kept', get data() { throw new Error('data unreadable'); } }),
  // An Error's message is the module's value, not always a string.
  bigmessage: () => ({ success: false, isError: true, error: Object.assign(new Error('x'), { message: 1n }) }),
  throwsbigmessage: () => { throw Object.assign(new Error('x'), { message: 2n }); },
};

class OddResults implements Module {
  readonly name = 'odd';
  /** Kept so a test can call a tool in process, as a module does. */
  ctx?: ModuleContext;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return Object.keys(RESULTS).map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
  }
  /** Two tools also reached through the `utils` meta-tool. */
  getUtilities(): ToolDefinition[] {
    return ['cyclic', 'datedata'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return RESULTS[call.name]!() as ToolResult;
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const text = String((event as { content?: unknown }).content);
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text }] }], requestInference: true };
  }
}

/** A workspace stand-in whose read_image handler, which the framework's
 *  read_image tool calls directly, returns what JSON can't hold. */
class OddWorkspace implements Module {
  readonly name = 'workspace';
  constructor(private readonly behaviour: 'cyclic' | 'throws' = 'cyclic') {}
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  async onProcess(): Promise<EventResponse> { return {}; }
  getTools(): ToolDefinition[] {
    return [{ name: 'read_image', description: 'read_image', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    if (this.behaviour === 'throws') throw Object.create(null);
    return { success: true, data: cyclic() };
  }
  async writeBinary(): Promise<{ success: boolean }> { return { success: false }; }
  async readBinary(): Promise<{ error: string }> { return { error: 'not used' }; }
}

/** Fails the test instead of hanging when a turn never settles. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} didn't finish within ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** A framework whose model calls `tools` in one round, then says "Noted." */
async function setUp(t: TestContext, tools: string[], extraModules: Module[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'unconvertible-result-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const membrane = new MockMembrane();
  // `utils:NAME` runs the module's utility NAME through the utils meta-tool.
  const toolUse = (tool: string) => tool.startsWith('utils:')
    ? { type: 'tool_use' as const, id: `call-${tool}`, name: 'utils', input: { action: 'run', name: `odd--${tool.slice('utils:'.length)}`, args: {} } }
    : { type: 'tool_use' as const, id: `call-${tool}`, name: tool.includes('--') || tool === 'read_image' ? tool : `odd--${tool}`, input: tool === 'read_image' ? { path: 'board/x.png' } : {} };
  membrane.pushResponse(createMockResponse(tools.map(toolUse), 'tool_use'));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Noted.' }]));
  const odd = new OddResults();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
    modules: [odd, ...extraModules],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  // Bounded, so a turn that never settled can't keep the file from ending.
  t.after(() => within(framework.stop(), 5_000, 'stop() in cleanup').catch(() => {}));
  return { framework, membrane, logged, odd };
}

const unusable = (tool: string, problem: string, own = '.') =>
  `Tool 'odd--${tool}' ${problem}. The call itself completed${own}`;
const unconvertible = (tool: string, reason: string, own?: string) =>
  unusable(tool, `returned a result that can't be converted to JSON, so it can't be stored or sent (${reason})`, own);
const unreadable = (tool: string, reason: string, own?: string) =>
  unusable(tool, `returned a result that can't be read, so it can't be stored or sent (${reason})`, own);

test('a round of results JSON cannot hold, or that hold no usable result, settles, and each reads as it should', async (t) => {
  const tools = ['cyclic', 'bigint', 'tojson', 'nodata', 'fn', 'errcyclic', 'errobjcyclic', 'objerror', 'errerror', 'nullerror',
    'quietfail', 'noresult', 'nullresult', 'arrayresult', 'stringresult', 'throwsbare', 'throwsempty', 'falseerror', 'emptyerror',
    'objmsgerror', 'fnerror', 'returnserror', 'sym', 'emptyreason', 'bothtext', 'nulldataquiet', 'plain',
    'resulttojson', 'tojsonignored', 'oncetojson', 'getterthrows', 'messagethrows', 'protogetter', 'errgetter',
    'bigmessage', 'throwsbigmessage', 'flagsread', 'fnflag', 'bigflag'];
  const { framework, membrane, logged } = await setUp(t, tools);
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'Call them all.', metadata: {} });
  await within(framework.runUntilIdle(), 10_000, 'the turn');
  assert.equal(framework.getAgent('assistant')!.state.status, 'idle', 'the turn settled');

  const sent = membrane.lastStream!.receivedToolResults[0] as Array<{ toolUseId: string; content: unknown; isError: boolean }>;
  const byTool = new Map(sent.map((r) => [r.toolUseId.slice('call-'.length), { content: r.content, isError: r.isError }]));
  const expected: Record<string, { content: string; isError: boolean }> = {
    cyclic: { content: unconvertible('cyclic', 'Converting circular structure to JSON'), isError: true },
    bigint: { content: unconvertible('bigint', 'Do not know how to serialize a BigInt'), isError: true },
    tojson: { content: unconvertible('tojson', 'a value with no text form'), isError: true },
    nodata: { content: '', isError: false },
    fn: { content: unusable('fn', "returned a function as its data, which JSON leaves out, so there's nothing to store or send"), isError: true },
    errcyclic: { content: unconvertible('errcyclic', 'Converting circular structure to JSON', ', with this error: Not found'), isError: true },
    errobjcyclic: { content: unconvertible('errobjcyclic', 'Converting circular structure to JSON', ', with this error: db timeout'), isError: true },
    objerror: { content: '{"code":"E42"}', isError: true },
    errerror: { content: 'db timeout', isError: true },
    // An error that says nothing reads as having no error text.
    nullerror: { content: 'Unknown error', isError: true },
    // A failure the tool doesn't flag as an error still says what failed.
    quietfail: { content: 'unknown channel: c1', isError: false },
    noresult: { content: unusable('noresult', "returned undefined instead of a result object, so there's nothing to store or send"), isError: true },
    nullresult: { content: unusable('nullresult', "returned null instead of a result object, so there's nothing to store or send"), isError: true },
    arrayresult: { content: unusable('arrayresult', "returned an array instead of a result object, so there's nothing to store or send"), isError: true },
    stringresult: { content: unusable('stringresult', "returned a string instead of a result object, so there's nothing to store or send"), isError: true },
    throwsbare: { content: 'a value with no text form', isError: true },
    // A throw or an error that says nothing reads as having no error text.
    throwsempty: { content: 'Unknown error', isError: true },
    falseerror: { content: 'Unknown error', isError: true },
    emptyerror: { content: 'Unknown error', isError: true },
    // An error is kept as its text, so a cyclic value inside it costs nothing.
    objmsgerror: { content: 'socket closed', isError: true },
    // An error result reads as its error, whatever its data.
    fnerror: { content: 'Not found', isError: true },
    returnserror: { content: unusable('returnserror', "returned an Error instead of a result object, so there's nothing to store or send", ', with this error: db timeout'), isError: true },
    sym: { content: unusable('sym', "returned a symbol as its data, which JSON leaves out, so there's nothing to store or send"), isError: true },
    emptyreason: { content: unconvertible('emptyreason', 'no reason given'), isError: true },
    bothtext: { content: '{"ok":1}', isError: false },
    nulldataquiet: { content: 'gone', isError: false },
    plain: { content: '{"ok":true}', isError: false },
    resulttojson: { content: unconvertible('resulttojson', 'Do not know how to serialize a BigInt'), isError: true },
    tojsonignored: { content: '{"kept":true}', isError: false },
    oncetojson: { content: '{"once":true}', isError: false },
    getterthrows: { content: unreadable('getterthrows', 'a value with no text form'), isError: true },
    messagethrows: { content: unreadable('messagethrows', 'message unreadable'), isError: true },
    protogetter: { content: '{"from":"getter"}', isError: false },
    errgetter: { content: unreadable('errgetter', 'data unreadable', ', with this error: kept'), isError: true },
    bigmessage: { content: '1', isError: true },
    throwsbigmessage: { content: '2', isError: true },
    // Flags reach the model as booleans, read for their truth.
    flagsread: { content: '{"ok":1}', isError: false },
    fnflag: { content: 'flagged by a function', isError: true },
    bigflag: { content: 'flagged by a BigInt', isError: true },
  };
  for (const tool of tools) assert.deepEqual(byTool.get(tool), expected[tool], tool);
  for (const tool of ['cyclic', 'bigint', 'tojson', 'fn', 'errcyclic', 'errobjcyclic', 'noresult', 'nullresult', 'arrayresult', 'stringresult',
    'returnserror', 'sym', 'emptyreason', 'resulttojson', 'getterthrows', 'messagethrows', 'errgetter']) {
    assert.ok(logged.includes(`[tools] agent assistant: ${expected[tool]!.content}`), `${tool} is logged:\n${logged.join('\n')}`);
  }
  await within(framework.stop(), 10_000, 'stop()');
});

for (const [tool, error] of [
  ['endturn', unconvertible('endturn', 'Do not know how to serialize a BigInt')],
  ['endturngetter', unreadable('endturngetter', 'gone')],
] as const) {
  test(`an unusable result that ends the turn still ends it (${tool})`, async (t) => {
    const { framework, membrane } = await setUp(t, [tool]);
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'Sleep.', metadata: {} });
    await within(framework.runUntilIdle(), 10_000, 'the turn');
    assert.equal(framework.getAgent('assistant')!.state.status, 'idle');
    // An ended turn stores the result instead of sending it, so the model
    // never answers it.
    assert.deepEqual(membrane.lastStream!.receivedToolResults, [], 'the result was not sent back to the model');
    const stored = JSON.stringify(framework.getAgent('assistant')!.getContextManager().getAllMessages());
    assert.ok(stored.includes(JSON.stringify(error).slice(1, -1)), stored);
    assert.equal(stored.includes('Noted.'), false, 'no reply after the call that ended the turn');
    await within(framework.stop(), 10_000, 'stop()');
  });
}

test("the read_image tool's handler, throwing a value with no text form, is answered with an error", async (t) => {
  const { framework, membrane } = await setUp(t, ['read_image'], [new OddWorkspace('throws')]);
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'Look.', metadata: {} });
  await within(framework.runUntilIdle(), 10_000, 'the turn');
  const sent = membrane.lastStream!.receivedToolResults[0] as Array<{ content: unknown; isError: boolean }>;
  assert.deepEqual(sent.map((r) => ({ content: r.content, isError: r.isError })), [{ content: 'a value with no text form', isError: true }]);
  await within(framework.stop(), 10_000, 'stop()');
});

test('a script reads a quiet failure as its error text, and an unusable result as the same error', async (t) => {
  const { framework } = await setUp(t, []);
  // A script's call is answered through the event loop, so it has to run.
  framework.start();
  const script = (tool: string) => (framework as unknown as {
    handleScriptToolCall(agent: string, tool: string, args: Record<string, unknown>): Promise<ScriptToolResult>;
  }).handleScriptToolCall('assistant', `odd--${tool}`, {});
  // A failure the tool doesn't flag reads as the model reads it, isError
  // false: the script's .is_error follows the result's flag, not its text.
  assert.deepEqual(await within(script('quietfail'), 10_000, 'the call'), { text: 'unknown channel: c1', isError: false });
  assert.deepEqual(await within(script('nulldataquiet'), 10_000, 'the call'), { text: 'gone', isError: false });
  // Text that only starts like an error isn't flagged as one: the flag is
  // the result's, not the text's prefix.
  assert.deepEqual(await within(script('prefixquiet'), 10_000, 'the call'), { text: 'Error: quota is fine', isError: false });
  assert.deepEqual(await within(script('cyclic'), 10_000, 'the call'), { text: `Error: ${unconvertible('cyclic', 'Converting circular structure to JSON')}`, isError: true });
  assert.deepEqual(await within(script('getterthrows'), 10_000, 'the call'), { text: `Error: ${unreadable('getterthrows', 'a value with no text form')}`, isError: true });
  await within(framework.stop(), 10_000, 'stop()');
});

test("a result the script's serializer can't convert reaches the script as an error, flagged as one", async (t) => {
  // The dispatch's own check (storableToolResult) turns such a result into an
  // error first, so these returns are reached only past it: here, with the
  // dispatch answering a cyclic result directly.
  const { framework } = await setUp(t, []);
  const internals = framework as unknown as {
    dispatchScriptToolCall: () => Promise<ToolResult>;
    handleScriptToolCall(agent: string, tool: string, args: Record<string, unknown>): Promise<ScriptToolResult>;
  };
  const reason = 'Converting circular structure to JSON';
  internals.dispatchScriptToolCall = async () => ({ success: true, data: cyclic() });
  const text = await internals.handleScriptToolCall('assistant', 'odd--cyclic', {});
  assert.equal(text.isError, true);
  assert.equal(text.structuredJson, undefined);
  assert.ok(text.text.startsWith("Error: tool 'odd--cyclic' returned a result that can't be converted to JSON, so the script can't receive it"), text.text);
  assert.ok(text.text.includes(reason), text.text);
  internals.dispatchScriptToolCall = async () => ({ success: true, structured: cyclic() });
  const structured = await internals.handleScriptToolCall('assistant', 'odd--cyclic', {});
  assert.equal(structured.isError, true);
  assert.equal(structured.structuredJson, true);
  const object = JSON.parse(structured.text) as { content: unknown[]; structuredContent: unknown; isError: boolean; error: string };
  assert.deepEqual({ ...object, error: undefined }, { content: [], structuredContent: null, isError: true, error: undefined });
  assert.ok(object.error.includes(reason), object.error);
});

test("the read_image tool's own handler gets the same check", async (t) => {
  const { framework, membrane, logged } = await setUp(t, ['read_image'], [new OddWorkspace()]);
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'Look.', metadata: {} });
  await within(framework.runUntilIdle(), 10_000, 'the turn');
  assert.equal(framework.getAgent('assistant')!.state.status, 'idle', 'the turn settled');
  const sent = membrane.lastStream!.receivedToolResults[0] as Array<{ toolUseId: string; content: unknown; isError: boolean }>;
  const error = "Tool 'read_image' returned a result that can't be converted to JSON, so it can't be stored or sent (Converting circular structure to JSON). The call itself completed.";
  assert.deepEqual(sent.map((r) => ({ id: r.toolUseId, content: r.content, isError: r.isError })), [{ id: 'call-read_image', content: error, isError: true }]);
  assert.ok(logged.includes(`[tools] agent assistant: ${error}`), logged.join('\n'));
  await within(framework.stop(), 10_000, 'stop()');
});

test("a puppeted call stores the checked result, returning the error for an unusable one and the tool's own for a usable one, and a direct call gets the module's own result", async (t) => {
  const { framework, logged } = await setUp(t, []);
  const { result } = await within(framework.puppetToolCall('assistant', 'odd--cyclic', {}), 10_000, 'the puppeted call');
  const error = unconvertible('cyclic', 'Converting circular structure to JSON');
  assert.deepEqual(result, { success: false, isError: true, error });
  const stored = JSON.stringify(framework.getAgent('assistant')!.getContextManager().getAllMessages());
  assert.ok(stored.includes(JSON.stringify(error).slice(1, -1)), stored);
  // A usable result is stored in its JSON form, and the caller gets the
  // tool's own result back, as on main.
  const { result: dated } = await within(framework.puppetToolCall('assistant', 'odd--datedata', {}), 10_000, 'the puppeted call');
  assert.ok((dated.data as { at: unknown }).at instanceof Date, 'the caller gets the Date itself');
  const storedNow = JSON.stringify(framework.getAgent('assistant')!.getContextManager().getAllMessages());
  assert.ok(storedNow.includes('{\\"at\\":\\"1970-01-01T00:00:00.000Z\\"}'), storedNow);
  // A direct call uses the result in process, so it gets the module's own
  // result, unchecked, and nothing is logged for it.
  const direct = await framework.executeToolCall({ id: 'direct-1', name: 'odd--cyclic', input: {} });
  assert.equal(direct.success, true);
  const loop = direct.data as Record<string, unknown>;
  assert.equal(loop.self, loop, 'the cyclic object itself');
  assert.deepEqual(logged.filter((line) => line.startsWith('[tools]')), [`[tools] agent assistant: ${error}`]);
  await within(framework.stop(), 10_000, 'stop()');
});

test("a caller that uses the result in process gets the module's own result, as on main", async (t) => {
  const { framework, odd } = await setUp(t, []);
  const at = (result: ToolResult) => (result.data as { at: unknown }).at;
  // executeToolCall, ModuleContext.callTool, and a utility through either.
  assert.ok(at(await framework.executeToolCall({ id: 'direct-date', name: 'odd--datedata', input: {} })) instanceof Date);
  assert.ok(at(await odd.ctx!.callTool({ id: 'ctx-date', name: 'odd--datedata', input: {} })) instanceof Date);
  const viaUtils = { name: 'utils', input: { action: 'run', name: 'odd--datedata', args: {} } };
  assert.ok(at(await framework.executeToolCall({ id: 'utils-date', ...viaUtils })) instanceof Date);
  assert.ok(at(await odd.ctx!.callTool({ id: 'ctx-utils-date', ...viaUtils })) instanceof Date);
  // Its flags as the module returned them, and its getters unread.
  assert.deepEqual(await framework.executeToolCall({ id: 'direct-flags', name: 'odd--flagsread', input: {} }),
    { success: 1, isError: 0, endTurn: 0, data: { ok: 1 } });
  const getter = await framework.executeToolCall({ id: 'direct-getter', name: 'odd--getterthrows', input: {} });
  assert.throws(() => getter.data, 'the getter is the module\'s own');
  // A throw is still answered as an error result, its text a string.
  assert.deepEqual(await framework.executeToolCall({ id: 'direct-throw', name: 'odd--throwsbigmessage', input: {} }),
    { success: false, isError: true, error: '2' });
  assert.deepEqual(await framework.executeToolCall({ id: 'direct-empty', name: 'odd--throwsempty', input: {} }),
    { success: false, isError: true }, 'a throw with no text has no error text');
  await within(framework.stop(), 10_000, 'stop()');
});

test("the model's call through the utils meta-tool takes the checked form", async (t) => {
  const { framework, membrane } = await setUp(t, ['utils:cyclic']);
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'Run it.', metadata: {} });
  await within(framework.runUntilIdle(), 10_000, 'the turn');
  assert.equal(framework.getAgent('assistant')!.state.status, 'idle', 'the turn settled');
  const sent = membrane.lastStream!.receivedToolResults[0] as Array<{ content: unknown; isError: boolean }>;
  assert.deepEqual(sent.map((r) => ({ content: r.content, isError: r.isError })),
    [{ content: unconvertible('cyclic', 'Converting circular structure to JSON'), isError: true }]);
  await within(framework.stop(), 10_000, 'stop()');
});

test("the direct Agent API reads each field of its caller's result once", async () => {
  // The Agent class turns a result its caller hands it into history text
  // without the framework's check, so a getter is read as it was written.
  const { Agent } = await import('../src/agent.js');
  const agent = new Agent(
    { name: 'direct', model: 'test-model', systemPrompt: 'sys' },
    {} as never,
    {} as never,
  );
  const oneRead = (value: unknown) => {
    let reads = 0;
    return () => {
      reads += 1;
      if (reads > 1) throw new Error('read a second time');
      return value;
    };
  };
  const data = oneRead('the payload');
  const quietError = oneRead('what failed');
  const quietData = oneRead(undefined);
  const results = [
    { id: 'a', name: 'withData', result: { success: true, get data() { return data(); } } },
    { id: 'b', name: 'quiet', result: { success: false, isError: false, get data() { return quietData(); }, get error() { return quietError(); } } },
  ];
  const built = (agent as unknown as { buildToolResultMessages(r: unknown[]): Array<{ content: Array<{ content: string }> }> })
    .buildToolResultMessages(results);
  assert.deepEqual(built[0].content.map((block) => block.content), [JSON.stringify('the payload'), 'what failed']);
});


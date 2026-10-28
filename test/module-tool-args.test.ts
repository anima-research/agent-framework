/**
 * A module tool's call is checked against the tool's declared inputSchema
 * before the module runs: an input that's there but isn't an object, or one
 * missing a required key, is refused with what to send, and the handler never
 * sees the call. An absent input gives no arguments. Values go to the handler
 * as they came, since a handler may take more than its schema can say. The
 * utils tool checks a utility's values too.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ToolCall, ToolResult, ToolDefinition } from '../src/types/index.js';
import { toolArgsProblems } from '../src/tool-args.js';
import { DiscordModule } from '../src/modules/discord/index.js';
import type { DiscordClientInterface } from '../src/modules/discord/types.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const SCHEMA: ToolDefinition['inputSchema'] = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    count: { type: 'integer' },
    mode: { type: 'string', enum: ['a', 'b'] },
    id: { type: 'number' },
    note: { type: ['string', 'null'] },
    opts: { type: 'object' },
  },
  required: ['path'],
};

const WRITE_SCHEMA: ToolDefinition['inputSchema'] = {
  type: 'object',
  properties: { path: { type: 'string' }, content: { type: 'string' } },
  required: ['path', 'content'],
};

/** A tool whose arguments are all optional. */
const OPEN_SCHEMA: ToolDefinition['inputSchema'] = {
  type: 'object',
  properties: { verbose: { type: 'boolean' } },
};

const RARE_SCHEMA: ToolDefinition['inputSchema'] = {
  type: 'object',
  properties: { mode: { type: 'string', enum: ['x', 'y'] } },
  required: ['mode'],
};

/**
 * A module with three declared tools and a utility, and a handler that also
 * answers a name it doesn't declare. Its tool listing can be made to throw.
 */
class ProbeModule implements Module {
  readonly name = 'probe';
  calls: ToolCall[] = [];
  listingThrows = false;
  utilitiesThrow = false;
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    if (this.listingThrows) throw new Error('zz-listing broke');
    return [
      { name: 'echo', description: 'Echo the input.', inputSchema: SCHEMA },
      { name: 'write', description: 'Take two required keys.', inputSchema: WRITE_SCHEMA },
      { name: 'status', description: 'Take only optional keys.', inputSchema: OPEN_SCHEMA },
    ];
  }
  getUtilities(): ToolDefinition[] {
    if (this.utilitiesThrow) throw new Error('zz-utilities broke');
    return [{ name: 'rare_op', description: 'A rarely-used operation.', inputSchema: RARE_SCHEMA }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return { success: true, data: { handled: call.name, input: call.input } };
  }
  async onProcess(): Promise<Record<string, never>> {
    return {};
  }
}

async function withFramework(
  fn: (framework: AgentFramework, probe: ProbeModule, membrane: MockMembrane) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'module-tool-args-'));
  const probe = new ProbeModule();
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', allowedTools: 'all' }],
    modules: [probe],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  try {
    await fn(framework, probe, membrane);
  } finally {
    probe.listingThrows = false;
    probe.utilitiesThrow = false;
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const call = (framework: AgentFramework, input: unknown, name = 'probe--echo'): Promise<ToolResult> =>
  framework.executeToolCall({ id: 'zz-1', name, input: input as Record<string, unknown>, callerAgentName: 'agent' });

/** A framework with one module of the test's own. */
async function withModule(module: Module, fn: (framework: AgentFramework, membrane: MockMembrane) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'module-tool-args-own-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', allowedTools: 'all' }],
    modules: [module],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  try {
    await fn(framework, membrane);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A module with a tool and a utility of one name, each with its own schema. */
class TwinModule implements Module {
  readonly name = 'twin';
  calls: ToolCall[] = [];
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'dup', description: 'The tool.', inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }];
  }
  getUtilities(): ToolDefinition[] {
    return [{ name: 'dup', description: 'The utility.', inputSchema: { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] } }];
  }
  async handleToolCall(c: ToolCall): Promise<ToolResult> { this.calls.push(c); return { success: true, data: c.input }; }
  async onProcess(): Promise<Record<string, never>> { return {}; }
}

/** The tool results the model was sent for its first round of calls, once
 *  they arrive: the framework is started and woken for one turn. */
async function firstToolResults(framework: AgentFramework, membrane: MockMembrane): Promise<Array<{ isError?: boolean; content?: unknown }> | undefined> {
  framework.start();
  (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
    agentName: 'agent', reason: 'external-message', source: 'test', timestamp: Date.now(),
  });
  const stream = () => membrane.lastStream as unknown as { receivedToolResults: unknown[][] } | undefined;
  const deadline = Date.now() + 5_000;
  while ((stream()?.receivedToolResults.length ?? 0) < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return stream()?.receivedToolResults[0] as Array<{ isError?: boolean; content?: unknown }> | undefined;
}

describe('a module tool\'s arguments are checked before the module runs', () => {
  it('refuses a call missing a required argument, naming it and its type', async () => {
    await withFramework(async (framework, probe) => {
      const result = await call(framework, {});
      assert.equal(result.isError, true);
      // Checked once the call has opened: a failure that says nothing was done, not a refusal.
      assert.equal(result.refused, undefined);
      assert.equal(result.error, 'Nothing was done: probe--echo needs "path" (a string), and this call gave none.');
      assert.equal(probe.calls.length, 0, 'the handler never saw the call');
    });
  });

  it('names every missing required key at once', async () => {
    await withFramework(async (framework, probe) => {
      const result = await call(framework, {}, 'probe--write');
      assert.equal(result.error,
        'Nothing was done: probe--write needs "path" (a string), and this call gave none; ' +
        'needs "content" (a string), and this call gave none.');
      // A key sent under another name is named, so the retry can see why.
      const renamed = await call(framework, { file_path: 'a.txt', content: 'c' }, 'probe--write');
      assert.equal(renamed.error,
        'Nothing was done: probe--write needs "path" (a string), and this call gave none; "file_path" isn\'t one of its parameters.');
      assert.equal(probe.calls.length, 0);
    });
  });

  it('passes a well-formed call to the module as it came, unknown keys included', async () => {
    await withFramework(async (framework, probe) => {
      const input = { path: 'work/a.txt', count: 2, mode: 'b', note: null, zz_extra: true };
      const result = await call(framework, input);
      assert.equal(result.success, true, result.error);
      assert.deepEqual(probe.calls[0]!.input, input);
    });
  });

  it('leaves values to the module, which may take more than its schema says', async () => {
    await withFramework(async (framework, probe) => {
      // A number as text, a value outside the enum, and an array where an
      // object is declared: the module decides.
      const input = { path: 'p', count: '3', mode: 'z', opts: ['zz-one'] };
      const result = await call(framework, input);
      assert.equal(result.success, true, result.error);
      assert.deepEqual(probe.calls[0]!.input, input);
    });
  });

  it('refuses an input that\'s there but isn\'t an object, naming what it was', async () => {
    await withFramework(async (framework, probe) => {
      const cases: Array<[unknown, string]> = [
        ['zz-text', 'a string'], [7, 'a number'], [true, 'a boolean'], [['zz-one'], 'an array'],
        // Falsy, and still there: only undefined and null are an absent input.
        ['', 'a string'], [0, 'a number'], [false, 'a boolean'],
      ];
      for (const [input, kind] of cases) {
        const result = await call(framework, input);
        assert.equal(result.error, `Nothing was done: probe--echo its input must be an object, and this call gave ${kind}.`);
      }
      // A tool that requires nothing still can't read named arguments from a list.
      const listed = await call(framework, ['zz-one'], 'probe--status');
      assert.equal(listed.error, 'Nothing was done: probe--status its input must be an object, and this call gave an array.');
      assert.equal(probe.calls.length, 0);
    });
  });

  it('reads an absent input as no arguments: refused only for the keys a tool requires', async () => {
    await withFramework(async (framework, probe) => {
      for (const input of [undefined, null]) {
        const result = await call(framework, input);
        assert.equal(result.error, 'Nothing was done: probe--echo needs "path" (a string), and this call gave none.');
      }
      assert.equal(probe.calls.length, 0);
      for (const input of [undefined, null]) {
        const result = await call(framework, input, 'probe--status');
        assert.equal(result.success, true, result.error);
      }
      assert.deepEqual(probe.calls.map((c) => c.input), [undefined, null], 'the handler sees the input as it came');
    });
  });

  it('counts a required key given as null or undefined as missing, and an empty string as given', async () => {
    await withFramework(async (framework, probe) => {
      const result = await call(framework, { path: null, content: undefined }, 'probe--write');
      assert.equal(result.error,
        'Nothing was done: probe--write needs "path" (a string), and this call gave null; ' +
        'needs "content" (a string), and this call gave none.');
      assert.equal(probe.calls.length, 0);
      const empty = await call(framework, { path: '', content: '' }, 'probe--write');
      assert.equal(empty.success, true, empty.error);
      assert.deepEqual(probe.calls[0]!.input, { path: '', content: '' });
    });
  });

  it('checks a utility called by its own name, as a tool is', async () => {
    await withFramework(async (framework, probe) => {
      const missing = await call(framework, {}, 'probe--rare_op');
      assert.equal(missing.error, 'Nothing was done: probe--rare_op needs "mode" (a string), and this call gave none.');
      assert.equal(probe.calls.length, 0);
      // As with tools, the value itself is the handler's on this path.
      const given = await call(framework, { mode: 'z' }, 'probe--rare_op');
      assert.equal(given.success, true, given.error);
      assert.equal(probe.calls[0]!.name, 'rare_op');
    });
  });

  it('lists utilities only for a name the tools don\'t have, so a utility listing that throws reaches only calls to such names', async () => {
    await withFramework(async (framework, probe) => {
      probe.utilitiesThrow = true;
      const tool = await call(framework, { path: 'p' });
      assert.equal(tool.success, true, tool.error);
      const utility = await call(framework, { mode: 'x' }, 'probe--rare_op');
      assert.deepEqual(utility, { success: false, isError: true, error: 'zz-utilities broke' });
      // A name the module answers without declaring it is looked for there too.
      const undeclared = await call(framework, {}, 'probe--undeclared');
      assert.deepEqual(undeclared, { success: false, isError: true, error: 'zz-utilities broke' });
      assert.deepEqual(probe.calls.map((c) => c.name), ['echo']);
    });
  });

  it('takes a name a tool and a utility of one module share for the tool, whose schema applies', async () => {
    const twin = new TwinModule();
    await withModule(twin, async (framework) => {
      const listed = framework.getAllTools().filter((t) => t.name === 'twin--dup');
      assert.equal(listed.length, 1, 'one definition for the name');
      assert.equal(listed[0]!.description, 'The tool.');
      const tool = await framework.executeToolCall({ id: 'zz-twin-2', name: 'twin--dup', input: { b: 'x' }, callerAgentName: 'agent' });
      assert.equal(tool.error, 'Nothing was done: twin--dup needs "a" (a string), and this call gave none; "b" isn\'t one of its parameters.');
    });
  });

  it('names a key an act gave inside args that the utility doesn\'t declare, where a required one is missing', async () => {
    await withFramework(async (framework, probe) => {
      const opened = await call(framework, { toolset: 'settings' }, 'toolsets--open');
      assert.equal(opened.success, true, opened.error);
      const result = await call(framework, { tool: 'probe--rare_op', args: { mood: 'x' } }, 'toolsets--act');
      assert.match(String(result.error),
        /^Invalid arguments for probe--rare_op: args\.mode: required; "mood" isn't one of its parameters\. Nothing was sent/);
      assert.equal(probe.calls.length, 0);
    });
  });

  it('runs a name the module answers but doesn\'t declare, on a module that lists no utilities', async () => {
    class Plain implements Module {
      readonly name = 'plain';
      calls: ToolCall[] = [];
      async start(_ctx: ModuleContext): Promise<void> {}
      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] {
        return [{ name: 'echo', description: 'Echo the input.', inputSchema: SCHEMA }];
      }
      async handleToolCall(c: ToolCall): Promise<ToolResult> { this.calls.push(c); return { success: true }; }
      async onProcess(): Promise<Record<string, never>> { return {}; }
    }
    const plain = new Plain();
    await withModule(plain, async (framework) => {
      const result = await call(framework, {}, 'plain--former');
      assert.equal(result.success, true, result.error);
      assert.deepEqual(plain.calls.map((c) => c.name), ['former']);
    });
  });

  it('answers a throw from the module\'s own tool listing as an error result', async () => {
    await withFramework(async (framework, probe) => {
      probe.listingThrows = true;
      const result = await call(framework, { path: 'p' });
      assert.deepEqual(result, { success: false, isError: true, error: 'zz-listing broke' });
      assert.equal(probe.calls.length, 0);
    });
  });

  it('leaves a name the module answers but doesn\'t declare unchecked', async () => {
    await withFramework(async (framework, probe) => {
      const result = await call(framework, {}, 'probe--undeclared');
      assert.equal(result.success, true, result.error);
      assert.equal(probe.calls[0]!.name, 'undeclared');
      // Not even an input that isn't an object is refused there.
      const odd = await call(framework, 'zz', 'probe--undeclared');
      assert.equal(odd.success, true, odd.error);
      assert.equal(probe.calls[1]!.input, 'zz');
    });
  });

  it('answers a model\'s call with the refusal, as an error tool result', async () => {
    await withFramework(async (framework, probe, membrane) => {
      membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'zz-call', name: 'probe--echo', input: {} }], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-done' }]));
      const results = await firstToolResults(framework, membrane);
      assert.ok(results, 'the model was answered');
      assert.equal(results!.length, 1);
      assert.equal(results![0]!.isError, true);
      assert.ok(JSON.stringify(results![0]!.content).includes('Nothing was done: probe--echo needs \\"path\\" (a string), and this call gave none.'),
        JSON.stringify(results));
      assert.equal(probe.calls.length, 0);
    });
  });
});

describe('toolArgsProblems', () => {
  it('has nothing to say without a schema, or about keys the schema doesn\'t declare', () => {
    assert.deepEqual(toolArgsProblems({ a: 1 }, undefined), []);
    assert.deepEqual(toolArgsProblems({ zz: 1 }, { type: 'object' }, { values: true }), []);
  });

  it('checks values only when asked, and then reports every problem at once', () => {
    const input = { count: '3', mode: 'z', opts: [1] };
    assert.deepEqual(toolArgsProblems(input, SCHEMA), ['needs "path" (a string), and this call gave none']);
    assert.deepEqual(toolArgsProblems(input, SCHEMA, { values: true }), [
      'needs "path" (a string), and this call gave none',
      '"count" must be a number, and this call gave a string',
      '"mode" must be one of "a" or "b", and this call gave "z"',
      '"opts" must be an object, and this call gave an array',
    ]);
  });

  it('takes the digits of a large integer sent as text for a number, from 16 digits on', () => {
    assert.deepEqual(toolArgsProblems({ path: 'p', id: '1234567890123456789' }, SCHEMA, { values: true }), []);
    assert.deepEqual(toolArgsProblems({ path: 'p', id: '1234567890123456' }, SCHEMA, { values: true }), []);
    assert.deepEqual(toolArgsProblems({ path: 'p', id: '123456789012345' }, SCHEMA, { values: true }),
      ['"id" must be a number, and this call gave a string']);
    assert.deepEqual(toolArgsProblems({ path: 'p', id: '12' }, SCHEMA, { values: true }),
      ['"id" must be a number, and this call gave a string']);
    // An integer reads as a number here too.
    assert.deepEqual(toolArgsProblems({ path: 'p', count: '1234567890123456789' }, SCHEMA, { values: true }), []);
    assert.deepEqual(toolArgsProblems({ path: 'p', count: '123456789012345' }, SCHEMA, { values: true }),
      ['"count" must be a number, and this call gave a string']);
    // Only where a number is declared.
    assert.deepEqual(toolArgsProblems({ path: 'p', opts: '1234567890123456' }, SCHEMA, { values: true }),
      ['"opts" must be an object, and this call gave a string']);
  });

  it('reads a type list as any of its types', () => {
    assert.deepEqual(toolArgsProblems({ path: 'p', note: 'hi' }, SCHEMA, { values: true }), []);
    assert.deepEqual(toolArgsProblems({ path: 'p', note: null }, SCHEMA, { values: true }), []);
    assert.deepEqual(toolArgsProblems({ path: 'p', note: 7 }, SCHEMA, { values: true }),
      ['"note" must be a string or null, and this call gave a number']);
  });

  it('counts a required key given as null as missing, once, and checks an optional null\'s type', () => {
    assert.deepEqual(toolArgsProblems({ path: null }, SCHEMA, { values: true }), ['needs "path" (a string), and this call gave null']);
    assert.deepEqual(toolArgsProblems({ path: 'p', count: null }, SCHEMA, { values: true }),
      ['"count" must be a number, and this call gave null']);
  });

  it('takes null as a required key\'s value where its declared type admits null, or it declares none', () => {
    const nullable: ToolDefinition['inputSchema'] = {
      type: 'object',
      properties: { note: { type: ['string', 'null'] }, any: {} },
      required: ['note', 'any'],
    };
    assert.deepEqual(toolArgsProblems({ note: null, any: null }, nullable), []);
    assert.deepEqual(toolArgsProblems({ note: null, any: null }, nullable, { values: true }), []);
    assert.deepEqual(toolArgsProblems({}, nullable), [
      'needs "note" (a string or null), and this call gave none',
      'needs "any", and this call gave none',
    ]);
  });

  it('reads OpenAPI\'s nullable: true as admitting null beside the type', () => {
    const openApi = {
      type: 'object',
      properties: { note: { type: 'string', nullable: true }, count: { type: 'number', nullable: true }, plain: { type: 'string', nullable: false } },
      required: ['note', 'plain'],
    } as unknown as ToolDefinition['inputSchema'];
    assert.deepEqual(toolArgsProblems({ note: null, plain: 'p', count: null }, openApi, { values: true }), []);
    assert.deepEqual(toolArgsProblems({ note: 3, plain: null }, openApi, { values: true }), [
      'needs "plain" (a string), and this call gave null',
      '"note" must be a string or null, and this call gave a number',
    ]);
    assert.deepEqual(toolArgsProblems({ plain: 'p' }, openApi), ['needs "note" (a string or null), and this call gave none']);
    // With no declared type, nullable adds nothing: any value is taken, as before.
    const untyped = { type: 'object', properties: { any: { nullable: true } } } as unknown as ToolDefinition['inputSchema'];
    assert.deepEqual(toolArgsProblems({ any: 'x' }, untyped, { values: true }), []);
  });

  it('reads a key given as undefined as left out', () => {
    assert.deepEqual(toolArgsProblems({ path: undefined }, SCHEMA), ['needs "path" (a string), and this call gave none']);
    assert.deepEqual(toolArgsProblems({ path: 'p', count: undefined }, SCHEMA, { values: true }), []);
  });

  it('reads only the input\'s own keys, and a required list that isn\'t a list as requiring nothing', () => {
    assert.deepEqual(toolArgsProblems({}, { type: 'object', required: ['constructor'] }), ['needs "constructor", and this call gave none']);
    assert.deepEqual(toolArgsProblems({}, { type: 'object', required: true as unknown as string[] }), []);
    // An entry of the list that isn't a name is passed over.
    assert.deepEqual(toolArgsProblems({}, { type: 'object', required: ['a', 5, null] as unknown as string[] }),
      ['needs "a", and this call gave none']);
  });

  it('ignores a declared type or enum of the wrong shape rather than throwing on it', () => {
    const odd = {
      type: 'object',
      properties: { t: { type: [5, 'string'] }, e: { enum: 'x' } },
    } as unknown as ToolDefinition['inputSchema'];
    assert.deepEqual(toolArgsProblems({ t: 'ok', e: 'anything' }, odd, { values: true }), []);
    // A type list with an entry it can't read declares no type, as membrane reads it.
    assert.deepEqual(toolArgsProblems({ t: 3 }, odd, { values: true }), []);
  });

  it('takes a digit run only as the whole of a string, for a number', () => {
    assert.deepEqual(toolArgsProblems({ path: 'p', id: ['1234567890123456'] }, SCHEMA, { values: true }),
      ['"id" must be a number, and this call gave an array']);
    assert.deepEqual(toolArgsProblems({ path: 'p', id: '1234567890123456x' }, SCHEMA, { values: true }),
      ['"id" must be a number, and this call gave a string']);
    assert.deepEqual(toolArgsProblems({ path: 'p', id: 'x1234567890123456' }, SCHEMA, { values: true }),
      ['"id" must be a number, and this call gave a string']);
  });

  it('reports a wrong-typed value once, as its type, even where it has an enum', () => {
    assert.deepEqual(toolArgsProblems({ path: 'p', mode: 3 }, SCHEMA, { values: true }),
      ['"mode" must be a string, and this call gave a number']);
  });

  it('names a kind once when a type list names it twice', () => {
    const both: ToolDefinition['inputSchema'] = { type: 'object', properties: { n: { type: ['integer', 'number'] } } };
    assert.deepEqual(toolArgsProblems({ n: 'x' }, both, { values: true }), ['"n" must be a number, and this call gave a string']);
  });

  it('reports a required key the schema lists twice once', () => {
    const twice: ToolDefinition['inputSchema'] = { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'a'] };
    assert.deepEqual(toolArgsProblems({}, twice), ['needs "a" (a string), and this call gave none']);
  });

  it('names keys the call gave that the schema doesn\'t declare, only where a required key is missing', () => {
    assert.deepEqual(toolArgsProblems({ file_path: 'a.txt' }, WRITE_SCHEMA), [
      'needs "path" (a string), and this call gave none',
      'needs "content" (a string), and this call gave none',
      '"file_path" isn\'t one of its parameters',
    ]);
    assert.deepEqual(toolArgsProblems({ path: 'p', text: 't', mode: 'w' }, WRITE_SCHEMA), [
      'needs "content" (a string), and this call gave none',
      '"text" and "mode" aren\'t among its parameters',
    ]);
    const many = Object.fromEntries(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'].map((k) => [k, 1]));
    assert.deepEqual(toolArgsProblems(many, RARE_SCHEMA), [
      'needs "mode" (a string), and this call gave none',
      '"k1", "k2", "k3", "k4", "k5" and 2 more aren\'t among its parameters',
    ]);
    // Nothing missing, nothing said: an extra key is never refused for itself.
    assert.deepEqual(toolArgsProblems({ path: 'p', zz: 1 }, SCHEMA), []);
    assert.deepEqual(toolArgsProblems({ path: 'p', content: 'c', zz: 1 }, WRITE_SCHEMA, { values: true }), []);
    // A long key is shown briefly, as a value is.
    const long = 'k'.repeat(100);
    assert.deepEqual(toolArgsProblems({ [long]: 1 }, RARE_SCHEMA)[1], `"${'k'.repeat(79)}… isn't one of its parameters`);
  });

  it('names a key the schema declares neither in properties nor in required, however its properties are given', () => {
    // A properties of another shape declares nothing, even a key a string or a list has of its own.
    const cases: Array<[unknown, string]> = [[undefined, 'y'], [null, 'y'], [{}, 'y'], ['zz', 'length'], [['y'], '0']];
    for (const [properties, key] of cases) {
      const schema = { type: 'object', required: ['x'], ...(properties === undefined ? {} : { properties }) } as unknown as ToolDefinition['inputSchema'];
      assert.deepEqual(toolArgsProblems({ [key]: 1 }, schema), ['needs "x", and this call gave none', `"${key}" isn't one of its parameters`],
        JSON.stringify(properties));
    }
    // A key the schema requires is one of its parameters, declared in properties or not.
    const requiredOnly = { type: 'object', properties: {}, required: ['x', 'z'] } as unknown as ToolDefinition['inputSchema'];
    assert.deepEqual(toolArgsProblems({ x: undefined, z: 1, y: 1 }, requiredOnly),
      ['needs "x", and this call gave none', '"y" isn\'t one of its parameters']);
  });

  it('names none where the schema\'s root can declare keys another way', () => {
    const y = { properties: { y: { type: 'number' } } };
    const ways: Array<[string, Record<string, unknown>]> = [
      ['oneOf', { oneOf: [y] }],
      ['anyOf', { anyOf: [y] }],
      ['allOf', { allOf: [y] }],
      ['not', { not: { required: ['y'] } }],
      ['if', { if: { required: ['mode'] }, then: y }],
      ['$ref', { $ref: '#/$defs/args' }],
      ['$dynamicRef', { $dynamicRef: '#args' }],
      ['$recursiveRef', { $recursiveRef: '#' }],
      ['dependentSchemas', { dependentSchemas: { mode: y } }],
      ['dependencies with a schema', { dependencies: { mode: y } }],
      ['dependencies with a list', { dependencies: { mode: ['y'] } }],
      ['dependentRequired', { dependentRequired: { mode: ['y'] } }],
      ['patternProperties', { patternProperties: { '^y': { type: 'number' } } }],
      ['propertyNames', { propertyNames: { enum: ['x', 'y'] } }],
      ['enum', { enum: [{ x: 'a', y: 1 }] }],
      ['const', { const: { x: 'a', y: 1 } }],
      ['additionalProperties', { additionalProperties: { type: 'number' } }],
      ['unevaluatedProperties', { unevaluatedProperties: { type: 'number' } }],
      ['additionalProperties {}', { additionalProperties: {} }],
      ['additionalProperties true', { additionalProperties: true }],
      ['unevaluatedProperties true', { unevaluatedProperties: true }],
    ];
    for (const [way, fields] of ways) {
      const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], ...fields } as unknown as ToolDefinition['inputSchema'];
      // None at all: a key no part of the schema mentions goes unnamed too.
      assert.deepEqual(toolArgsProblems({ y: 1, zz: 1 }, schema), ['needs "x" (a string), and this call gave none'], way);
    }
    // false for additionalProperties or unevaluatedProperties takes no other keys, and then or
    // else without if, or a keyword JSON Schema doesn't have, declares none.
    const noWays: Array<[string, Record<string, unknown>]> = [
      ['additionalProperties false', { additionalProperties: false }],
      ['unevaluatedProperties false', { unevaluatedProperties: false }],
      ['then and else without if', { then: y, else: y }],
      ['a keyword JSON Schema lacks', { 'x-parameters': y }],
    ];
    for (const [way, fields] of noWays) {
      const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], ...fields } as unknown as ToolDefinition['inputSchema'];
      assert.deepEqual(toolArgsProblems({ y: 1 }, schema), ['needs "x" (a string), and this call gave none', '"y" isn\'t one of its parameters'], way);
    }
  });

  it('reads a type name JSON Schema doesn\'t have, alone or in a list, as declaring no type', () => {
    const anyTyped = {
      type: 'object',
      properties: {
        v: { type: 'any' },
        w: { type: ['any', 'string'] },
        n: { type: ['String', 'null'] },
        u: { type: 'any', nullable: true },
        t: {},
      },
      required: ['v', 'n', 'u', 't'],
    } as unknown as ToolDefinition['inputSchema'];
    // Its values aren't checked against the type, a list's known names included.
    assert.deepEqual(toolArgsProblems({ v: 3, w: 4, n: 'x', u: 5, t: 6 }, anyTyped, { values: true }), []);
    // Its enum still is, alone or in a list.
    const anyEnum = {
      type: 'object',
      properties: { e: { type: 'any', enum: ['a', 'b'] }, f: { type: ['STRING', 'null'], enum: ['c'] } },
    } as unknown as ToolDefinition['inputSchema'];
    assert.deepEqual(toolArgsProblems({ e: 'a', f: 'c' }, anyEnum, { values: true }), []);
    assert.deepEqual(toolArgsProblems({ e: 'z', f: 3 }, anyEnum, { values: true }), [
      '"e" must be one of "a" or "b", and this call gave "z"',
      '"f" must be one of "c", and this call gave 3',
    ]);
    // null is no value for a type the check can't read, unless the declaration names it;
    // a key with no type at all takes it.
    assert.deepEqual(toolArgsProblems({ v: null, n: null, u: null, t: null }, anyTyped), ['needs "v", and this call gave null']);
    assert.deepEqual(toolArgsProblems({}, anyTyped), ['needs "v", and this call gave none', 'needs "n", and this call gave none',
      'needs "u", and this call gave none', 'needs "t", and this call gave none']);
  });

  it('names the input by the caller\'s word for it', () => {
    assert.deepEqual(toolArgsProblems('zz', SCHEMA, { field: 'args' }), ['its args must be an object, and this call gave a string']);
  });

  it('words a three-way choice, an untyped key and a value it can\'t show', () => {
    assert.deepEqual(toolArgsProblems({ k: 'zz' }, { type: 'object', properties: { k: { type: 'string', enum: ['a', 'b', 'c'] } } }, { values: true }),
      ['"k" must be one of "a", "b" or "c", and this call gave "zz"']);
    assert.deepEqual(toolArgsProblems({}, { type: 'object', properties: { k: {} }, required: ['k'] }), ['needs "k", and this call gave none']);
    assert.deepEqual(toolArgsProblems({ k: 10n }, { type: 'object', properties: { k: { enum: ['a'] } } }, { values: true }),
      ['"k" must be one of "a", and this call gave (a value that could not be shown)']);
  });

  it('shows a long value briefly, cut between characters', () => {
    const [problem] = toolArgsProblems({ path: 'p', mode: 'x'.repeat(200) }, SCHEMA, { values: true });
    assert.ok(problem!.endsWith('…'), problem);
    assert.ok(problem!.length < 160, problem);
    // The 80th character of the shown text is an emoji, two UTF-16 units long.
    const [astral] = toolArgsProblems({ path: 'p', mode: `${'x'.repeat(78)}😀${'y'.repeat(10)}` }, SCHEMA, { values: true });
    assert.ok(astral!.includes('😀…'), astral);
    assert.doesNotMatch(astral!, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('shows a value of 80 characters whole, cuts one of 81, and shows a function, which JSON can\'t, by its own text', () => {
    const enumOnly: ToolDefinition['inputSchema'] = { type: 'object', properties: { k: { enum: ['a'] } } };
    // JSON.stringify quotes a string, so 78 characters show as 80.
    const [eighty] = toolArgsProblems({ k: 'x'.repeat(78) }, enumOnly, { values: true });
    assert.ok(eighty!.endsWith(`gave "${'x'.repeat(78)}"`), eighty);
    const [eightyOne] = toolArgsProblems({ k: 'x'.repeat(79) }, enumOnly, { values: true });
    assert.ok(eightyOne!.endsWith(`gave "${'x'.repeat(79)}…`), eightyOne);
    const [fn] = toolArgsProblems({ k: function named() {} }, enumOnly, { values: true });
    assert.match(fn!, /gave function named\(\) \{\s*\}$/);
  });
});

describe('a module tool that requires nothing reads an absent input as no arguments', () => {
  it('activates Discord speech when the call has no input at all', async () => {
    const discord = new DiscordModule({} as unknown as DiscordClientInterface, { token: 'test-token' });
    const registered: unknown[] = [];
    (discord as unknown as { ctx: ModuleContext }).ctx = {
      registerSpeechHandler: (_key: string, options: unknown) => { registered.push(options); },
    } as unknown as ModuleContext;
    for (const input of [undefined, null]) {
      const result = await discord.handleToolCall({ id: 'c1', name: 'activate', input } as unknown as ToolCall);
      assert.equal(result.success, true, result.error);
    }
    assert.deepEqual(registered, [{ additive: undefined }, { additive: undefined }]);
  });
});

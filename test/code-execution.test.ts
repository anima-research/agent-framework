/**
 * code_execution through the framework: an agent's script runs on the engine,
 * in a process of its own, and its calls come back through the ordinary
 * dispatcher as the agent's. Each test drives a full agent turn through the
 * MockMembrane, or the promise path (executeToolCall), and asserts what the
 * model and the modules see: inner tool results reach the running script but
 * never the model-facing tool_result.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ErrorAction, ErrorPolicy, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { storableToolResult } from '../src/module-registry.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';
import type { ContentBlock, NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { UNREACHED_WATCHDOG, silenceRun } from './helpers/run-watchdog.js';
import { captureTimers, fireTimer, type CapturedTimer } from './helpers/capture-timers.js';

/** Wait for a condition, failing after 15 s rather than hanging the run. */
const until = async (cond: () => boolean, what: string) => {
  const deadline = Date.now() + 15_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** A module's own result class, whose data and turn-ending are prototype getters, as a module may write one. */
class ClassResult {
  success = true;
  refused: boolean;
  constructor(refused: boolean) {
    this.refused = refused;
  }
  get data(): unknown {
    return { from: 'a getter' };
  }
  get endTurn(): boolean {
    return true;
  }
}

/** A result class whose structured view is a prototype getter, carrying a symbol-keyed field too. */
class StructuredResult {
  success = true;
  refused = true;
  constructor() {
    (this as unknown as Record<symbol, unknown>)[Symbol.for('test.tag')] = 'tagged';
  }
  get structured(): unknown {
    return { from: 'a getter' };
  }
  get keepWhenWithheld(): string[] {
    return ['path'];
  }
}

/** How many times the 'counted' odd claim's data getter has been read. */
let countedReads = 0;
/** How many times the 'endturn-throws' odd claim's endTurn getter has been read. */
let endTurnReads = 0;
/** How many times the 'error-throws' odd claim's error getter has been read. */
let errorReads = 0;

/** Results of odd shapes that claim a refusal, for the in-process route's copy. */
function oddClaim(kind: string): unknown {
  switch (kind) {
    case 'structured': return new StructuredResult();
    // Own fields named like Object.prototype's members are fields.
    case 'proto-names': return { success: true, refused: true, toString: 'mine', constructor: 'also mine' };
    case 'unreadable-refused': return { success: true, data: 1, get refused(): boolean { throw new Error('no claim to read'); } };
    // The claim can't be read, but the turn's end and the module's error can.
    case 'unreadable-refused-kept': return { success: false, endTurn: true, error: 'finished', get refused(): boolean { throw new Error('no claim to read'); } };
    // The turn's end and the module's error are read before success, which throws.
    case 'endturn-then-throw': return { isError: true, refused: true, endTurn: true, error: 'the module said why', get success(): boolean { throw new Error('unreadable success'); } };
    // The turn's end can't be read, the first time it's asked; the module's error can.
    case 'endturn-throws': {
      endTurnReads = 0;
      return {
        isError: true, refused: true, error: 'original failure',
        get endTurn(): boolean { endTurnReads += 1; if (endTurnReads === 1) throw new Error('no turn end'); return true; },
      };
    }
    // The module's error can't be read, the first time it's asked.
    case 'error-throws': {
      errorReads = 0;
      return {
        isError: true, refused: true,
        get error(): string { errorReads += 1; if (errorReads === 1) throw new Error('no error text'); return 'real failure'; },
      };
    }
    // An error whose own text can't be read, on a result that can't be copied.
    case 'unreadable-error': return { refused: true, endTurn: true, error: { get message(): string { throw new Error('no text'); } }, get data(): unknown { throw new Error('unreadable data'); } };
    // A field named __proto__, as JSON makes one.
    case 'proto-field': return JSON.parse('{"success": true, "refused": true, "__proto__": "mine"}');
    // An own getter for a declared field, read once.
    case 'counted': {
      countedReads = 0;
      return { success: true, refused: true, get data(): number { countedReads += 1; return countedReads; } };
    }
    case 'function': return Object.assign(() => 1, { refused: true, success: true });
    default: throw new Error(`no odd claim ${kind}`);
  }
}

/** Echoes its input, ends the turn, or answers when released. */
class ScriptToolModule implements Module {
  readonly name = 'test';
  readonly calls: ToolCall[] = [];
  private readonly gates: Array<() => void> = [];

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'echo',
        description: 'Echo input. Returns JSON: {"echoed": <input>}.',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      },
      { name: 'finish', description: 'End the turn.', inputSchema: { type: 'object', properties: {} } },
      { name: 'slow', description: 'Answers when the test releases it.', inputSchema: { type: 'object', properties: {} } },
      { name: 'claims_refused', description: 'Fails, claiming a refusal.', inputSchema: { type: 'object', properties: {} } },
      { name: 'slow_finish', description: 'Ends the turn when the test releases it.', inputSchema: { type: 'object', properties: {} } },
      { name: 'class_result', description: 'Answers with a result class whose data is a getter.', inputSchema: { type: 'object', properties: { refused: { type: 'boolean' } } } },
      { name: 'unreadable_claim', description: 'Claims a refusal on a result one of whose fields throws.', inputSchema: { type: 'object', properties: {} } },
      { name: 'odd_claim', description: 'Claims a refusal on a result of an odd shape.', inputSchema: { type: 'object', properties: { kind: { type: 'string' } } } },
    ];
  }

  /** Answer the oldest slow call waiting. */
  release(): boolean {
    const gate = this.gates.shift();
    gate?.();
    return gate !== undefined;
  }

  get waiting(): number {
    return this.gates.length;
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    const baseName = call.name.includes('--') ? call.name.slice(call.name.lastIndexOf('--') + 2) : call.name;
    if (baseName === 'finish') return { success: true, data: { finished: true }, endTurn: true };
    if (baseName === 'slow') await new Promise<void>((resolve) => this.gates.push(resolve));
    if (baseName === 'claims_refused') return { success: false, isError: true, refused: true, error: 'the tool says it refused' };
    if (baseName === 'slow_finish') {
      await new Promise<void>((resolve) => this.gates.push(resolve));
      return { success: true, data: { finished: true }, endTurn: true };
    }
    if (baseName === 'class_result') return new ClassResult(Boolean((call.input as { refused?: boolean }).refused)) as unknown as ToolResult;
    if (baseName === 'unreadable_claim') {
      return { success: false, isError: true, refused: true, get error(): string { throw new Error('unreadable'); } } as ToolResult;
    }
    if (baseName === 'odd_claim') return oddClaim(String((call.input as { kind?: unknown }).kind)) as ToolResult;
    return { success: true, data: { echoed: call.input } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      const content = (event as { content?: unknown }).content as Array<{ type: string; text?: string }>;
      return { addMessages: [{ participant: 'User', content: content as never }], requestInference: true };
    }
    return {};
  }
}

function tempStorePath(prefix: string): { tempDir: string; storePath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  return { tempDir, storePath: join(tempDir, 'store.chronicle') };
}

async function withFramework(
  prefix: string,
  options: { membrane?: MockMembrane; module?: Module; codeExecution?: Record<string, unknown>; resident?: boolean; errorPolicy?: ErrorPolicy },
  body: (framework: AgentFramework, membrane: MockMembrane) => Promise<void>,
): Promise<void> {
  const { tempDir, storePath } = tempStorePath(prefix);
  const membrane = options.membrane ?? new MockMembrane();
  const framework = await AgentFramework.create({
    storePath,
    membrane: membrane.asMembrane(),
    agents: options.resident
      ? [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }]
      : [],
    modules: [options.module ?? new ScriptToolModule()],
    syncIntervalMs: 0,
    codeExecution: { enabled: true, ...(options.codeExecution ?? {}) },
    ...(options.errorPolicy ? { errorPolicy: options.errorPolicy } : {}),
  });
  try {
    await body(framework, membrane);
  } finally {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Run one ephemeral agent's turn to its end. */
async function runEphemeral(framework: AgentFramework, name: string): Promise<{ speech: string; toolCallsCount: number }> {
  const created = await framework.createEphemeralAgent({ name, model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' });
  created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
  const promise = framework.runEphemeralToCompletion(created.agent, created.contextManager);
  framework.start();
  return promise as Promise<{ speech: string; toolCallsCount: number }>;
}

/** A stream whose provider fails before it sends anything: its first event is the error, as membrane reports one. */
class ProviderErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void {}
  cancel(): void {
    this.isCancelled = true;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

type WireResult = { toolUseId: string; content: string; isError?: boolean };

/** A code_execution result's text: its one text block, or its error. */
const resultText = (result: ToolResult): string =>
  result.isError ? result.error ?? '' : ((result.data as Array<{ text?: string }> | undefined)?.[0]?.text ?? '');

describe('code_execution through the framework', () => {
  it('is offered only when enabled, and says how a script calls its tools', async () => {
    const { tempDir, storePath } = tempStorePath('ce-off-');
    const off = await AgentFramework.create({
      storePath, membrane: new MockMembrane().asMembrane(), agents: [], modules: [new ScriptToolModule()], syncIntervalMs: 0,
    });
    try {
      assert.ok(!off.getAllTools().some((t) => t.name === 'code_execution'));
    } finally {
      await off.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
    await withFramework('ce-on-', {}, async (framework) => {
      const tool = framework.getAllTools().find((t) => t.name === 'code_execution');
      assert.ok(tool, 'code_execution is synthesized');
      assert.match(tool.description, /Run JavaScript/);
      assert.match(tool.description, /tools\["module--tool"\]\(\{ \.\.\.its arguments \}\)/);
      assert.match(tool.description, /A script has 128 MiB of memory/);
    });
  });

  it("runs a script that calls module tools as the agent's; intermediates never reach the model", async () => {
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();
    const code = [
      'const names = [];',
      'for (const m of ["alpha", "beta"]) {',
      '  const r = await tools["test--echo"]({ message: m });',
      '  names.push(JSON.parse(r.content[0].text).echoed.message.toUpperCase() + ":" + r.isError);',
      '}',
      'text("summary: " + names.join("+"));',
      'return names.length;',
    ].join('\n');
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Let me fan out.' },
      { type: 'tool_use', id: 'call_ce_1', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Final answer.' }]));
    await withFramework('ce-run-', { membrane, module }, async (framework) => {
      const result = await runEphemeral(framework, 'worker');
      assert.strictEqual(result.speech, 'Final answer.');
      const echoCalls = module.calls.filter((c) => c.name.endsWith('echo'));
      assert.strictEqual(echoCalls.length, 2);
      for (const call of echoCalls) assert.notStrictEqual(call.id, 'call_ce_1', "an inner call isn't dispatched under the model's call id");
      const [results] = membrane.lastStream!.receivedToolResults as WireResult[][];
      assert.strictEqual(results!.length, 1);
      const wire = results![0]!;
      assert.strictEqual(wire.toolUseId, 'call_ce_1');
      assert.match(wire.content, /^Script s\d+-[0-9a-z]{4} finished\./);
      assert.match(wire.content, /Its calls: 2 \(2 answered\)\./);
      assert.match(wire.content, /It returned: 2/);
      assert.match(wire.content, /summary: ALPHA:false\+BETA:false/);
      assert.ok(!wire.content.includes('"echoed"'), 'intermediate tool results must not reach the model-facing result');
    });
  });

  it('a module tool that returns a string hands the script that string, not its JSON encoding', async () => {
    // The tool contract: a script's tool function returns "the same text the
    // tool would have returned to you directly". For a string result that
    // is the string itself, newlines and quotes intact.
    const listing = 'As of 10:00.\n[review] org/repo#1 "Fix it"';
    class ListingModule extends ScriptToolModule {
      override getTools(): ToolDefinition[] {
        return [...super.getTools(), {
          name: 'listing',
          description: 'A line-per-item listing.',
          inputSchema: { type: 'object', properties: {} },
        }];
      }
      override async handleToolCall(call: ToolCall): Promise<ToolResult> {
        if (call.name.endsWith('listing')) return { success: true, data: listing };
        return super.handleToolCall(call);
      }
    }
    const membrane = new MockMembrane();
    const code = [
      'const r = await tools["test--listing"]({});',
      'const t = r.content[0].text;',
      'const lines = t.split("\\n");',
      'text("count: " + lines.length);',
      'text("second: " + lines[1]);',
      'text("quoted: " + t.startsWith(\'"\'));',
    ].join('\n');
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_ce_str', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    await withFramework('ce-string-', { membrane, module: new ListingModule() }, async (framework) => {
      await runEphemeral(framework, 'worker');
      const [results] = membrane.lastStream!.receivedToolResults as WireResult[][];
      const wire = results![0]!;
      assert.strictEqual(wire.toolUseId, 'call_ce_str');
      assert.match(wire.content, /count: 2/);
      assert.match(wire.content, /second: \[review\] org\/repo#1 "Fix it"/);
      assert.match(wire.content, /quoted: false/);
    });
  });

  it("an MCP tool's text-only result reaches the model and a script as that text, not its JSON encoding", async () => {
    // The MCPL tool-result mapping hands a result whose blocks are all text
    // on as their joined text, so an MCP tool's text answer is string data
    // too: the model and a script get the text as the server sent it.
    const listing = 'As of 10:00.\n[review] org/repo#1 "Fix it"';
    // A stdio MCPL server whose one tool answers with a single text block
    // holding the `text` it was given. It accepts the framework's initial
    // featureSets/update, as the fixtures' servers do, so the connection
    // doesn't wait out the policy request's timeout.
    const server = `
      let buf = '';
      process.stdin.on('data', (c) => {
        buf += c.toString('utf8');
        let i;
        while ((i = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let m; try { m = JSON.parse(line); } catch { continue; }
          const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
          if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', serverInfo: { name: 'echo', version: '1.0.0' }, capabilities: { tools: {}, experimental: { mcpl: { version: '0.4' } } } });
          else if (m.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }] });
          else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: String(m.params.arguments.text) }] });
          else if (m.method === 'featureSets/update') { if (m.id !== undefined) reply({ accepted: true }); }
        }
      });
    `;
    const { tempDir, storePath } = tempStorePath('ce-mcp-string-');
    const membrane = new MockMembrane();
    const code = [
      `const r = await tools["mcpl--echo--echo"]({ text: ${JSON.stringify(listing)} });`,
      'const t = r.content[0].text;',
      'const lines = t.split("\\n");',
      'text("count: " + lines.length);',
      'text("second: " + lines[1]);',
      'text("quoted: " + t.startsWith(\'"\'));',
    ].join('\n');
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_mcp_direct', name: 'mcpl--echo--echo', input: { text: listing } },
      { type: 'tool_use', id: 'call_mcp_script', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));

    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [],
      mcplServers: [{ id: 'echo', command: process.execPath, args: ['-e', server] }],
      syncIntervalMs: 0,
      codeExecution: { enabled: true },
    });
    try {
      await framework.start();
      await until(() => framework.getAllTools().some((t) => t.name === 'mcpl--echo--echo'), 'the echo server\'s tool');
      const created = await framework.createEphemeralAgent({ name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      await framework.runEphemeralToCompletion(created.agent, created.contextManager);
      const wire = membrane.lastStream!.receivedToolResults[0] as WireResult[];
      const direct = wire.find((r) => r.toolUseId === 'call_mcp_direct');
      assert.strictEqual(direct?.content, listing, 'the model gets the text, not its JSON encoding');
      const script = wire.find((r) => r.toolUseId === 'call_mcp_script');
      assert.ok(script, 'the script call has a result');
      assert.match(script.content, /count: 2/);
      assert.match(script.content, /second: \[review\] org\/repo#1 "Fix it"/);
      assert.match(script.content, /quoted: false/);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('two code_execution calls in one response both run, and the turn completes', async () => {
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();
    const code = (label: string) => `const r = await tools["test--echo"]({ message: "${label}" }); text("ran: " + JSON.parse(r.content[0].text).echoed.message);`;
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_two_a', name: 'code_execution', input: { code: code('a') } },
      { type: 'tool_use', id: 'call_two_b', name: 'code_execution', input: { code: code('b') } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Both answered.' }]));
    await withFramework('ce-two-', { membrane, module }, async (framework) => {
      const result = await runEphemeral(framework, 'pair');
      assert.strictEqual(result.speech, 'Both answered.');
      const [results] = membrane.lastStream!.receivedToolResults as WireResult[][];
      const byId = new Map(results!.map((r) => [r.toolUseId, r.content]));
      assert.match(byId.get('call_two_a') ?? '', /ran: a/);
      assert.match(byId.get('call_two_b') ?? '', /ran: b/);
    });
  });

  it("a script's call whose result ends the turn ends it at the code_execution result", async () => {
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Finishing via script.' },
      { type: 'tool_use', id: 'call_ce_2', name: 'code_execution', input: { code: 'const r = await tools["test--finish"]({}); await tools["test--echo"]({ message: "after finish: " + r.isError });' } },
    ], 'tool_use'));
    // No further response: endTurn must settle the turn without another round.
    await withFramework('ce-endturn-', { membrane, module }, async (framework) => {
      const result = await runEphemeral(framework, 'finisher');
      assert.strictEqual(module.calls.filter((c) => c.name.endsWith('finish')).length, 1);
      // The script went on after the call that ends the turn, to its own end.
      assert.deepEqual(module.calls.filter((c) => c.name.endsWith('echo')).map((c) => c.input), [{ message: 'after finish: false' }]);
      assert.strictEqual(result.toolCallsCount, 1); // one model-visible call: code_execution
    });
  });

  it('a script still running after yield_time_ms yields with its output, and a wait returns what came since', async () => {
    const module = new ScriptToolModule();
    await withFramework('ce-yield-', { module }, async (framework) => {
      framework.start();
      const run = (input: Record<string, unknown>) => framework.executeToolCall({ id: `ce-${Math.random()}`, name: 'code_execution', input });
      const first = await run({ code: 'text("before"); await tools["test--slow"]({}); text("after"); return "done";', yield_time_ms: 100 });
      const firstText = resultText(first);
      assert.ok(first.success, firstText);
      assert.match(firstText, /^Script (s\d+-[0-9a-z]{4}) is still running after 100 ms\./);
      const id = /^Script (s\d+-[0-9a-z]{4})/.exec(firstText)![1];
      // Once its call waits, what it wrote first has come back by one return or the next.
      await until(() => module.waiting === 1, 'the slow call');
      const middle = await run({ action: 'wait', script_id: id, yield_time_ms: 0 });
      const middleText = resultText(middle);
      assert.match(middleText, /Its calls so far: 1 \(1 still running\)\./);
      const outputOf = (text: string) => /\n(?:Its output|Its output since the last return):\n([\s\S]*)$/.exec(text)?.[1] ?? '';
      assert.equal(outputOf(firstText) + outputOf(middleText), 'before\n');
      module.release();
      const second = await run({ action: 'wait', script_id: id });
      const secondText = resultText(second);
      assert.match(secondText, new RegExp(`^Script ${id} finished\\.`));
      assert.match(secondText, /It returned: "done"/);
      assert.match(secondText, /Its output since the last return:\nafter\n$/);
    });
  });

  it("a module's result can't claim a refusal: the script gets the tool's failure, and its record counts the call as answered", async () => {
    await withFramework('ce-claims-', {}, async (framework) => {
      framework.start();
      const result = await framework.executeToolCall({
        id: 'ce-claims',
        name: 'code_execution',
        input: { code: 'try { const r = await tools["test--claims_refused"]({}); return [r.isError, r.content[0].text]; } catch (e) { return ["threw", e.name]; }' },
      });
      const text = resultText(result);
      assert.ok(result.success, text);
      assert.match(text, /It returned: \[true,"the tool says it refused"\]/);
      assert.match(text, /Its calls: 1 \(1 answered with an error\)\./);
      // Called directly, in process, the module's result doesn't carry the claim either.
      const direct = await framework.executeToolCall({ id: 'claims-direct', name: 'test--claims_refused', input: {} });
      assert.equal(direct.isError, true);
      assert.equal(direct.refused, undefined);
      assert.equal(direct.error, 'the tool says it refused');
      // Nor does the result stored, for a module called outside the registry's route.
      const stored = storableToolResult({ id: 'claims-stored', name: 'test--claims_refused', input: {} }, { success: false, isError: true, refused: true, error: 'the tool says it refused' });
      assert.equal(stored.refused, undefined);
      assert.equal(stored.isError, true);
      assert.equal(stored.error, 'the tool says it refused');
      // A result class claiming it keeps its getters' values, less the claim.
      const classed = await framework.executeToolCall({ id: 'class-claims', name: 'test--class_result', input: { refused: true } });
      assert.equal(classed.refused, undefined);
      assert.deepEqual(classed.data, { from: 'a getter' });
      assert.equal(classed.endTurn, true);
      // One with no claim is the module's own object, its getters as they are.
      const own = await framework.executeToolCall({ id: 'class-own', name: 'test--class_result', input: { refused: false } });
      assert.ok(own instanceof ClassResult);
      // A claim on a result that can't be read for its copy: a failure saying so, never the claim.
      const unreadable = await framework.executeToolCall({ id: 'unreadable', name: 'test--unreadable_claim', input: {} });
      assert.equal(unreadable.refused, undefined);
      assert.equal(unreadable.isError, true);
      assert.match(unreadable.error ?? '', /returned a result that couldn't be read \(unreadable\)\. The call itself completed\./);
      const odd = (kind: string) => framework.executeToolCall({ id: `odd-${kind}`, name: 'test--odd_claim', input: { kind } });
      // Every field ToolResult declares is read by name, a prototype getter's included, and a symbol field stays.
      const structured = await odd('structured') as ToolResult & Record<symbol, unknown>;
      assert.equal(structured.refused, undefined);
      assert.deepEqual(structured.structured, { from: 'a getter' });
      assert.deepEqual(structured.keepWhenWithheld, ['path']);
      assert.equal(structured[Symbol.for('test.tag')], 'tagged');
      // Own fields named like Object.prototype's members are copied as fields.
      const named = await odd('proto-names') as unknown as Record<string, unknown>;
      assert.equal(Object.prototype.hasOwnProperty.call(named, 'toString'), true);
      assert.equal(named.toString, 'mine');
      assert.equal(named.constructor, 'also mine');
      // A claim that can't be read is a result that can't be read: a failure, never a success without it.
      const unreadableClaim = await odd('unreadable-refused');
      assert.equal(unreadableClaim.success, false);
      assert.equal(unreadableClaim.refused, undefined);
      assert.match(unreadableClaim.error ?? '', /couldn't be read \(no claim to read\)\. The call itself completed\.$/);
      // A failure keeps the turn's end and the module's error, read before the field that threw.
      const kept = await odd('endturn-then-throw');
      assert.equal(kept.endTurn, true);
      assert.match(kept.error ?? '', /couldn't be read \(unreadable success\)\. The call itself completed, with this error: the module said why$/);
      // A turn's end that can't be read leaves the failure ending no turn, and keeps the
      // module's error; its getter is asked once, not again for the failure.
      const throwsEnd = await odd('endturn-throws');
      assert.equal(throwsEnd.endTurn, undefined);
      assert.match(throwsEnd.error ?? '', /couldn't be read \(no turn end\)\. The call itself completed, with this error: original failure$/);
      assert.equal(endTurnReads, 1);
      // So is an error that can't be read: the failure says why, and doesn't ask again.
      const throwsError = await odd('error-throws');
      assert.match(throwsError.error ?? '', /couldn't be read \(no error text\)\. The call itself completed\.$/);
      assert.equal(errorReads, 1);
      // A claim that can't be read keeps them too.
      const keptUnclaimed = await odd('unreadable-refused-kept');
      assert.equal(keptUnclaimed.endTurn, true);
      assert.match(keptUnclaimed.error ?? '', /couldn't be read \(no claim to read\)\. The call itself completed, with this error: finished$/);
      // An error whose own text can't be read: the failure says only why.
      const noText = await odd('unreadable-error');
      assert.equal(noText.endTurn, true);
      assert.match(noText.error ?? '', /couldn't be read \(unreadable data\)\. The call itself completed\.$/);
      // A field named __proto__ stays a field, and the copy's prototype is an object's.
      const protoField = await odd('proto-field') as unknown as Record<string, unknown>;
      assert.equal(Object.prototype.hasOwnProperty.call(protoField, '__proto__'), true);
      assert.equal(Object.getOwnPropertyDescriptor(protoField, '__proto__')?.value, 'mine');
      assert.equal(Object.getPrototypeOf(protoField), Object.prototype);
      // A declared field's own getter is read once.
      const counted = await odd('counted');
      assert.equal(counted.data, 1);
      assert.equal(countedReads, 1);
      // A function result is checked for the claim too, and its non-enumerable own fields aren't copied.
      const fn = await odd('function');
      assert.equal(fn.refused, undefined);
      assert.equal(fn.success, true);
      assert.equal(Object.prototype.hasOwnProperty.call(fn, 'name'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(fn, 'length'), false);
    });
  });

  it("a script's call whose result ends the turn ends it at the call watching when it comes, a later wait's", async () => {
    const module = new ScriptToolModule();
    await withFramework('ce-late-endturn-', { module }, async (framework) => {
      framework.start();
      const run = (input: Record<string, unknown>) => framework.executeToolCall({ id: `ce-${Math.random()}`, name: 'code_execution', input });
      const first = await run({ code: 'await tools["test--slow_finish"]({}); return "after";', yield_time_ms: 100 });
      assert.equal(first.endTurn, undefined, 'the run yielded before the result');
      const id = /^Script (s\d+-[0-9a-z]{4})/.exec(resultText(first))![1]!;
      await until(() => module.waiting === 1, 'the gated call');
      const scripts = (framework as unknown as { codeExecution: { scripts: { scripts: Map<string, { watch: unknown }> } } }).codeExecution.scripts;
      const waiting = run({ action: 'wait', script_id: id });
      await until(() => scripts.scripts.get(id)?.watch != null, 'the wait watching the script');
      module.release();
      const second = await waiting;
      assert.match(resultText(second), /It returned: "after"/);
      assert.equal(second.endTurn, true, "the later wait's result ends the turn");
    });
  });

  it("a stop watches with its own call's watch, so a turn-ending result that comes during it ends the stop's turn", async () => {
    await withFramework('ce-stop-watch-', {}, async (framework) => {
      framework.start();
      const run = (input: Record<string, unknown>) => framework.executeToolCall({ id: `ce-${Math.random()}`, name: 'code_execution', input });
      const first = await run({ code: 'for (;;) {}', yield_time_ms: 100 });
      assert.match(resultText(first), /is still running after/);
      const id = /^Script (s\d+-[0-9a-z]{4})/.exec(resultText(first))![1]!;
      const scripts = (framework as unknown as { codeExecution: { scripts: { stop(agent: string, id: string, watch?: { endTurn: boolean }): Promise<unknown> } } }).codeExecution.scripts;
      const realStop = scripts.stop.bind(scripts);
      let passed: { endTurn: boolean } | undefined;
      // A turn-ending result that comes while the stop watches marks the watch it was given.
      scripts.stop = async (agent, scriptId, watch) => {
        passed = watch;
        if (watch) watch.endTurn = true;
        return realStop(agent, scriptId, watch);
      };
      const stopped = await run({ action: 'stop', script_id: id });
      assert.ok(passed, "the stop was given the call's watch");
      assert.match(resultText(stopped), /was stopped, as you asked/);
      assert.equal(stopped.endTurn, true);
    });
  });

  it("a script call that got no result from the host is answered for by the bridge's timer, marked so its place stays taken", async (t) => {
    await withFramework('ce-no-result-', {}, async (framework) => {
      const fw = framework as unknown as {
        codeExecution: { settings: { toolCallTimeoutMs: number } };
        dispatchToolCall(agent: string, call: unknown, turnId?: number): void;
        scriptToolCall(agent: string, tool: string, args: string, context: Record<string, unknown>): Promise<{ held?: boolean; json: string }>;
        toolLifecycleEmitter: unknown;
      };
      // The dispatch loses the call: no result ever comes.
      fw.dispatchToolCall = () => {};
      // What observers are told of the call (RFC-007).
      const told: Array<[string, unknown[]]> = [];
      fw.toolLifecycleEmitter = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => { told.push([String(name), args]); } });
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const answering = fw.scriptToolCall('agent', 'test--echo', '{}', {});
      t.mock.timers.tick(fw.codeExecution.settings.toolCallTimeoutMs + 30_000);
      // The timer answers at the tick: a few turns of the loop bound the wait, so a timer that never fired fails here.
      const answer = await Promise.race([
        answering,
        (async () => {
          for (let i = 0; i < 100; i++) await new Promise((res) => setImmediate(res));
          throw new Error('no answer came after the tick');
        })(),
      ]);
      t.mock.timers.reset();
      assert.equal(answer.held, true);
      assert.match(answer.json, /produced no result within/);
      // The call is closed for observers as one that failed with no result:
      // marked failed first, so its result closes it as a failure.
      const names = told.map(([name]) => name);
      const failedAt = names.indexOf('markDispatchFailure');
      const closedAt = names.indexOf('onResult');
      assert.ok(failedAt >= 0 && closedAt > failedAt, names.join(', '));
      assert.equal(told[failedAt]![1][1], told[closedAt]![1][1], 'the same call');
      assert.equal(told[closedAt]![1][2], undefined, 'with no result');
    });
  });

  it("a non-primary agent's run made in a turn that has ended is refused: its script would outlive the turn", async () => {
    await withFramework('ce-ended-turn-', {}, async (framework) => {
      const fw = framework as unknown as { primaryAgentName: string | undefined; openLogical: Map<string, object> };
      fw.primaryAgentName = 'prime';
      const run = (agent: string, turnId: number | undefined) => framework.executeToolCall({
        id: `ce-${Math.random()}`, name: 'code_execution', input: { code: 'return 1;', yield_time_ms: 10_000 },
        callerAgentName: agent, ...(turnId === undefined ? {} : { callerTurnId: turnId }),
      });
      const refused = await run('helper', 999);
      assert.equal(refused.isError, true);
      assert.match(refused.error ?? '', /the turn this call was made in has ended, and only the primary agent's scripts outlive a turn/);
      // The primary agent's scripts outlive turns, and a call made in no turn has none to outlive.
      assert.match(resultText(await run('prime', 999)), /finished/);
      assert.match(resultText(await run('helper', undefined)), /finished/);
      // A run made in the helper's turn still open runs.
      fw.openLogical.set('helper', { turnId: 5 });
      assert.match(resultText(await run('helper', 5)), /finished/);
      fw.openLogical.delete('helper');
      // With no primary agent, every agent's scripts outlive its turns.
      fw.primaryAgentName = undefined;
      assert.match(resultText(await run('helper', 999)), /finished/);
    });
  });

  it("a cancelled stream that no longer owns its agent abandons its own turn, and its settle ends that turn, not every turn", async () => {
    await withFramework('ce-cancel-own-turn-', {}, async (framework) => {
      const fw = framework as unknown as {
        settleDeliberateCancel(args: Record<string, unknown>): void;
        codeExecution: { scripts: { turnEnded(agent: string, turn: unknown, abandoned: boolean): void } };
      };
      const ended: unknown[] = [];
      fw.codeExecution.scripts.turnEnded = (agent, turn, abandoned) => { ended.push([agent, turn, abandoned]); };
      // A newer stream (2) took the agent; this one (1) is cancelled.
      const agent = { name: 'helper', streamId: 2, reset: () => {}, toolResultGuard: { hasPending: false }, getContextManager: () => ({ addMessage: () => {} }) };
      fw.settleDeliberateCancel({ agent, myStreamId: 1, startTime: Date.now(), compiledRequest: undefined, reason: 'user', closes: undefined, stream: { turnId: 3 }, log: () => {} });
      assert.deepEqual(ended, [['helper', { id: 3, live: [] }, true], ['helper', { id: 3, live: [] }, true]]);
    });
  });

  it("a conversation fork that is disposed tells the scripts its agent has gone", async () => {
    await withFramework('ce-fork-gone-', {}, async (framework) => {
      const fw = framework as unknown as {
        disposeConversationAgent(agent: string): void;
        codeExecution: { scripts: { agentGone(agent: string): void } };
      };
      const gone: string[] = [];
      fw.codeExecution.scripts.agentGone = (agent) => { gone.push(agent); };
      fw.disposeConversationAgent('fork-1');
      assert.deepEqual(gone, ['fork-1']);
    });
  });

  it("with toolCallTimeoutMs at the longest a timer can wait, the bridge's own timer doesn't fire at once", async () => {
    await withFramework('ce-longest-timeout-', {}, async (framework) => {
      const fw = framework as unknown as {
        codeExecution: { settings: { toolCallTimeoutMs: number } };
        scriptToolWaiters: Map<string, { resolve: (result: ToolResult) => void }>;
        dispatchToolCall(agent: string, call: { id: string }, turnId?: number): void;
        scriptToolCall(agent: string, tool: string, args: string, context: Record<string, unknown>): Promise<{ held?: boolean; json: string }>;
      };
      fw.codeExecution.settings.toolCallTimeoutMs = 2_147_483_647;
      // The tool answers after 50 ms: a timer that overflowed would have answered for it within 1 ms.
      fw.dispatchToolCall = (_agent, call) => {
        setTimeout(() => fw.scriptToolWaiters.get(call.id)?.resolve({ success: true, data: { echoed: true } }), 50);
      };
      const answer = await fw.scriptToolCall('agent', 'test--echo', '{}', {});
      assert.equal(answer.held, undefined);
      assert.match(answer.json, /echoed/);
    });
  });

  it("every settle that carries its turn ends that turn's scripts, naming the turns still live", async () => {
    await withFramework('ce-stale-settle-', {}, async (framework) => {
      const fw = framework as unknown as {
        openLogical: Map<string, object>;
        turnRouting: Map<string, object>;
        activeTurnTokens: Map<string, number>;
        settleAgent(agent: string, outcome: { stopReason: string; speech: string }, closes: object | undefined, stream?: object): void;
        abandonAgentScripts(agent: string, reason: string, stream: object | 'every'): void;
        endDroppedTurn(agent: string, routing: object): void;
        liveTurns(agent: string, ending: object | undefined): number[];
        codeExecution: { scripts: { turnEnded(agent: string, turn: unknown, abandoned: boolean): void } };
      };
      const ended: unknown[] = [];
      fw.codeExecution.scripts.turnEnded = (agent, turn, abandoned) => { ended.push([agent, turn, abandoned]); };
      // Routings as freshTurnRouting numbers them: a later one has a larger id.
      const [turn1, turn2, silent3, newer4] = [{ turnId: 1 }, { turnId: 2 }, { turnId: 3 }, { turnId: 4 }];
      // A stale settle: turn 2 is open, and stays so, and is named live.
      fw.openLogical.set('a', turn2);
      fw.settleAgent('a', { stopReason: 'exhausted', speech: '' }, turn1);
      assert.deepEqual(ended.at(-1), ['a', { id: 1, live: [2] }, true]);
      assert.equal(fw.openLogical.get('a'), turn2);
      // The open turn's own settle closes it: no turn is live after it.
      fw.settleAgent('a', { stopReason: 'end_turn', speech: '' }, turn2);
      assert.deepEqual(ended.at(-1), ['a', { id: 2, live: [] }, false]);
      // A silent turn beside an open one names that turn live, so its scripts are left alone.
      fw.openLogical.set('c', turn2);
      fw.settleAgent('c', { stopReason: 'end_turn', speech: '' }, silent3);
      assert.deepEqual(ended.at(-1), ['c', { id: 3, live: [2] }, false]);
      // A stream that no longer owns the agent still ends its own turn, and the
      // start in progress that took the agent, holding its turn, is live.
      fw.turnRouting.set('d', newer4);
      fw.activeTurnTokens.set('d', 1);
      fw.settleAgent('d', { stopReason: 'end_turn', speech: '' }, undefined, silent3);
      assert.deepEqual(ended.at(-1), ['d', { id: 3, live: [4] }, false]);
      // Each exclusion on its own: the ending's own routing isn't live though its
      // start holds the turn, and a latest start that holds no turn isn't live.
      assert.deepEqual(fw.liveTurns('d', newer4), []);
      fw.activeTurnTokens.delete('d');
      assert.deepEqual(fw.liveTurns('d', silent3), []);
      fw.activeTurnTokens.set('d', 1);
      assert.deepEqual(fw.liveTurns('d', silent3), [4]);
      fw.activeTurnTokens.delete('d');
      // A settle with no turn at all ends nothing.
      const before = ended.length;
      fw.settleAgent('d', { stopReason: 'end_turn', speech: '' }, undefined);
      assert.equal(ended.length, before);
      // An abandoned stream abandons its own turn, not the latest start's,
      // naming the open one live; every turn is the host's stop.
      fw.turnRouting.set('c', newer4);
      fw.abandonAgentScripts('c', 'stream error', silent3);
      assert.deepEqual(ended.at(-1), ['c', { id: 3, live: [2] }, true]);
      fw.activeTurnTokens.set('c', 2);
      fw.abandonAgentScripts('c', 'stream error', silent3);
      assert.deepEqual(ended.at(-1), ['c', { id: 3, live: [2, 4] }, true]);
      fw.activeTurnTokens.delete('c');
      fw.abandonAgentScripts('c', 'framework shutting down', 'every');
      assert.deepEqual(ended.at(-1), ['c', 'every', true]);
      // A start dropped before its stream sent anything ends its turn too.
      const dropped5 = { turnId: 5 };
      fw.openLogical.set('e', dropped5);
      fw.turnRouting.set('e', dropped5);
      fw.activeTurnTokens.set('e', 4);
      fw.endDroppedTurn('e', dropped5);
      assert.deepEqual(ended.at(-1), ['e', { id: 5, live: [] }, false]);
      assert.equal(fw.openLogical.get('e'), undefined);
      assert.deepEqual(fw.liveTurns('e', undefined), [], 'and it is no longer live, though its start still holds the token');
      fw.activeTurnTokens.delete('e');
      // A turn that has settled isn't live, though its start's teardown, such
      // as its speech's delivery, still holds the agent's token.
      const late6 = { turnId: 6 };
      fw.turnRouting.set('f', late6);
      fw.activeTurnTokens.set('f', 3);
      assert.deepEqual(fw.liveTurns('f', undefined), [6]);
      fw.settleAgent('f', { stopReason: 'end_turn', speech: '' }, undefined, late6);
      assert.deepEqual(fw.liveTurns('f', undefined), []);
      fw.activeTurnTokens.delete('f');
    });
  });

  it("a stream whose provider fails abandons its own turn, not every turn of its agent's, before the retry", async () => {
    const membrane = new MockMembrane();
    let streams = 0;
    membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
      membrane.calls.push(request);
      streams += 1;
      return streams === 1
        ? new ProviderErrorStream(new Error('provider unavailable'))
        : new MockYieldingStream([createMockResponse([{ type: 'text', text: 'done' }])]);
    };
    const errorPolicy: ErrorPolicy = {
      maxRetries: 1,
      onInferenceError: (_error: Error, _agent: string, attempt: number): ErrorAction => (attempt < 1 ? { retry: true, delayMs: 0 } : { retry: false }),
    };
    await withFramework('ce-stream-error-turn-', { membrane, errorPolicy }, async (framework) => {
      const scripts = (framework as unknown as {
        codeExecution: { scripts: { turnEnded(agent: string, turn: unknown, abandoned: boolean, reason?: string): void } };
      }).codeExecution.scripts;
      const turnEnded = scripts.turnEnded.bind(scripts);
      const ended: Array<[string, unknown, boolean, string | undefined]> = [];
      scripts.turnEnded = (agent, turn, abandoned, reason) => {
        ended.push([agent, turn, abandoned, reason]);
        turnEnded(agent, turn, abandoned, reason);
      };
      const { speech } = await runEphemeral(framework, 'helper');
      assert.equal(speech, 'done');
      assert.equal(streams, 2, 'the failed stream was retried');
      const abandons = ended.filter(([agent, , abandoned, reason]) => agent === 'helper' && abandoned && reason === 'stream error');
      assert.equal(abandons.length, 1, 'the failure abandons once');
      const turn = abandons[0][1];
      assert.notEqual(turn, 'every', "the failed stream's own turn, not every turn of its agent's");
    });
  });

  it("the Python runner's inputs are refused by name, saying what replaced each", async () => {
    await withFramework('ce-old-', {}, async (framework) => {
      framework.start();
      const run = (input: Record<string, unknown>) => framework.executeToolCall({ id: `ce-${Math.random()}`, name: 'code_execution', input });
      const background = await run({ code: 'return 1;', background: true });
      assert.equal(background.isError, true);
      assert.match(background.error ?? '', /^background is no longer an input: .* yields and keeps running/);
      assert.match((await run({ code: 'return 1;', time_limit_ms: 1000 })).error ?? '', /^time_limit_ms is now yield_time_ms/);
      assert.match((await run({ action: 'cancel', script_id: 's1' })).error ?? '', /^cancel is now stop/);
      assert.match((await run({ code: '' })).error ?? '', /a run needs `code`/);
      assert.match((await run({ action: 'wait' })).error ?? '', /wait needs `script_id`/);
    });
  });

  it('list and stop manage scripts, and a run past maxRunningScripts is refused with nothing run', async () => {
    const module = new ScriptToolModule();
    await withFramework('ce-list-', { module, codeExecution: { maxRunningScripts: 1 } }, async (framework) => {
      framework.start();
      const run = (input: Record<string, unknown>) => framework.executeToolCall({ id: `ce-${Math.random()}`, name: 'code_execution', input });
      const first = await run({ code: 'await tools["test--slow"]({});', yield_time_ms: 100 });
      const id = /^Script (s\d+-[0-9a-z]{4})/.exec(resultText(first))![1]!;
      await until(() => module.waiting === 1, 'the slow call');
      const second = await run({ code: 'return 1;' });
      assert.equal(second.isError, true);
      assert.match(second.error ?? '', /You have 1 scripts running, your most\..*Nothing was run\./s);
      assert.match(resultText(await run({ action: 'list' })), new RegExp(`- ${id}: running for under a minute`));
      const stopped = await run({ action: 'stop', script_id: id });
      assert.ok(stopped.success, 'the agent\'s own stop is not an error');
      assert.match(resultText(stopped), new RegExp(`^Script ${id} was stopped, as you asked\\.`));
      assert.match(resultText(stopped), /\n- still running when the script ended, so it may or may not take effect: tools\["test--slow"\]\(\{\}\)\n/);
      assert.match(resultText(await run({ action: 'list' })), new RegExp(`- ${id}: stopped by you`));
    });
  });

  it("a resident's left script wakes it with wake_agent(), and its failure wakes it too", async () => {
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();
    const code = [
      'await tools["test--slow"]({});',
      'await wake_agent({ found: "signal" });',
      'await tools["test--slow"]({});',
      'throw new Error("watcher broke");',
    ].join('\n');
    // Turn 1: start the script, which yields; then rest.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Arming watcher.' },
      { type: 'tool_use', id: 'call_bg1', name: 'code_execution', input: { code, yield_time_ms: 100 } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Watcher armed; resting.' }]));
    // Turns 2 and 3, the wakes, get their responses just before each starts:
    // the stand-in membrane gives a stream every response queued when it opens.
    await withFramework('ce-wake-', { membrane, module, resident: true, codeExecution: { wakeMinIntervalMs: 0 } }, async (framework) => {
      let turnsEnded = 0;
      framework.onTrace((event) => {
        if (event.type === 'inference:completed' && event.agentName === 'prime') turnsEnded++;
      });
      framework.start();
      framework.pushEvent({
        type: 'external-message', source: 'test', content: [{ type: 'text', text: 'arm a watcher' }], metadata: {}, triggerInference: true,
      } as unknown as ProcessEvent);
      const wakes = () => ((framework.getAgent('prime')?.getContextManager().queryMessages({}).messages ?? []) as unknown as Array<{
        content: Array<{ text?: string }>; metadata?: { source?: string; tags?: string[]; scriptId?: string };
      }>).filter((m) => m.metadata?.source === 'code-execution-script');
      await until(() => module.waiting === 1, 'the first slow call');
      await until(() => turnsEnded === 1, 'the first turn to end, so the wake finds the agent at rest');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Woke and handled.' }]));
      module.release();
      await until(() => wakes().length === 1, 'the wake_agent() wake');
      assert.match(wakes()[0]!.content[0]!.text ?? '', /^\[script s\d+-[0-9a-z]{4}\] Woke you with wake_agent\(\), 0 min after it started \(wake 1 of 100\): \{"found":"signal"\}$/);
      // The wake asks for a turn: an inference whose request carries it.
      const requested = (text: string) => membrane.calls.some((request) => JSON.stringify(request).includes(text));
      await until(() => requested('Woke you with wake_agent()'), "the wake's inference request");
      assert.deepEqual(wakes()[0]!.metadata?.tags, ['script:wake']);
      assert.equal(wakes()[0]!.metadata?.scriptId, /^\[script (\S+)\]/.exec(wakes()[0]!.content[0]!.text ?? '')?.[1], 'the script the wake names');
      await until(() => module.waiting === 1, 'the second slow call');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Saw the failure.' }]));
      module.release();
      await until(() => wakes().length === 2, 'the failure wake');
      // The script's own source says "watcher broke" too, so the notice's own words are what's looked for.
      await until(() => requested('Your script failed: Error: watcher broke'), "the failure wake's inference request");
      assert.match(wakes()[1]!.content[0]!.text ?? '', /^\[script (s\d+-[0-9a-z]{4})\] Your script failed: Error: watcher broke\. \{"action": "wait", "script_id": "\1"\} gives its result\.$/);
    });
  });

  it('stop() stops every script still running, quietly', async () => {
    const module = new ScriptToolModule();
    const { tempDir, storePath } = tempStorePath('ce-stop-');
    const framework = await AgentFramework.create({
      storePath, membrane: new MockMembrane().asMembrane(), agents: [], modules: [module], syncIntervalMs: 0, codeExecution: { enabled: true },
    });
    try {
      framework.start();
      const left = await framework.executeToolCall({ id: 'ce-left', name: 'code_execution', input: { code: 'await tools["test--slow"]({});', yield_time_ms: 100 } });
      assert.match(resultText(left), /is still running/);
      await until(() => module.waiting === 1, 'the slow call');
      const scripts = (framework as unknown as { codeExecution: { scripts: { running(agent: string): number; list(agent: string): Array<{ ending: unknown }>; live: Set<unknown> } } }).codeExecution.scripts;
      const woke: unknown[] = [];
      (framework as unknown as { scriptWake: (...args: unknown[]) => Promise<void> }).scriptWake = async (...args) => { woke.push(args); };
      await framework.stop();
      // Its stop has been awaited: the script has ended and its process has exited.
      assert.equal(scripts.running('__ephemeral__'), 0);
      assert.equal(scripts.live.size, 0);
      assert.deepEqual(scripts.list('__ephemeral__')[0]!.ending, { how: 'stopped', reason: 'limit', why: 'the host stopped' });
      assert.deepEqual(woke, [], 'a stop by the host wakes no one');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("an ephemeral agent's scripts end with its run", async () => {
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_eph', name: 'code_execution', input: { code: 'await tools["test--slow"]({});', yield_time_ms: 100 } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Left it running.' }]));
    await withFramework('ce-eph-', { membrane, module }, async (framework) => {
      const result = await runEphemeral(framework, 'helper');
      assert.strictEqual(result.speech, 'Left it running.');
      const [results] = membrane.lastStream!.receivedToolResults as WireResult[][];
      assert.match(results![0]!.content, /is still running after 100 ms/);
      const scripts = (framework as unknown as { codeExecution: { scripts: { running(agent: string): number } } }).codeExecution.scripts;
      await until(() => scripts.running('helper') === 0, "the ephemeral agent's script to stop");
    });
  });

  it("an ephemeral agent's left script stops when its run ends, though no primary agent is named and its scripts outlive a turn", async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_spin', name: 'code_execution', input: { code: 'for (;;) {}', yield_time_ms: 100 } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Left it spinning.' }]));
    await withFramework('ce-eph-gone-', { membrane }, async (framework) => {
      const scripts = (framework as unknown as { codeExecution: { scripts: {
        running(agent: string): number;
        list(agent: string): Array<{ ending: unknown }>;
        run(...args: unknown[]): Promise<{ ending: unknown }>;
      } } }).codeExecution.scripts;
      // The run that left it running: its return had no ending.
      const realRun = scripts.run.bind(scripts);
      let leftRunning = false;
      scripts.run = async (...args: unknown[]) => {
        const r = await realRun(...args);
        if (r.ending === null) leftRunning = true;
        return r;
      };
      const result = await runEphemeral(framework, 'spinner');
      assert.strictEqual(result.speech, 'Left it spinning.');
      assert.ok(leftRunning, 'the script was left running');
      // Its turn's end left the script running; only the agent's end stops it.
      await until(() => scripts.running('spinner') === 0, "the ephemeral agent's script to stop");
      // A gone agent keeps no scripts: nothing could wait on them or list them.
      assert.deepEqual(scripts.list('spinner'), []);
    });
  });

  it("the bridge refuses a script's call that isn't JSON, isn't an object, or comes once the host is stopping, with nothing sent", async () => {
    const module = new ScriptToolModule();
    await withFramework('ce-bridge-', { module }, async (framework) => {
      const bridge = (args: string) => (framework as unknown as {
        scriptToolCall(agent: string, tool: string, argsJson: string, context: object): Promise<{ ok: boolean; json: string }>;
      }).scriptToolCall('__ephemeral__', 'test--echo', args, {});
      const refusal = async (args: string) => { const a = await bridge(args); assert.equal(a.ok, false); return (JSON.parse(a.json) as { message: string }).message; };
      assert.match(await refusal('{"oops'), /test--echo's arguments weren't JSON; nothing was done/);
      assert.match(await refusal('[1]'), /test--echo's arguments must be an object; nothing was done/);
      const stopping = framework.stop();
      assert.match(await refusal('{}'), /this host is stopping; nothing was done/);
      await stopping;
      assert.equal(module.calls.length, 0);
    });
  });

  it('once the host has begun to stop, a run starts no script', async () => {
    const module = new ScriptToolModule();
    await withFramework('ce-stopping-', { module }, async (framework) => {
      framework.start();
      const stopping = framework.stop();
      const r = await framework.executeToolCall({ id: 'ce-late', name: 'code_execution', input: { code: 'return 1;' } });
      assert.equal(r.success, false);
      assert.match(r.error ?? '', /stopping/);
      await stopping;
      const scripts = (framework as unknown as { codeExecution: { scripts: { list(agent: string): unknown[] } } }).codeExecution.scripts;
      assert.deepEqual(scripts.list('__ephemeral__'), []);
    });
  });

  it("a script's ALL_TOOLS carries each tool's description and input schema as its agent's tool list gives them", async () => {
    const module = new ScriptToolModule();
    await withFramework('ce-alltools-', { module }, async (framework) => {
      framework.start();
      const r = await framework.executeToolCall({
        id: 'ce-all', name: 'code_execution',
        input: { code: 'const t = ALL_TOOLS.find((x) => x.name === "test--echo"); return { description: t.description, inputSchema: t.inputSchema };', yield_time_ms: 30_000 },
      });
      const echo = framework.getAllTools().find((t) => t.name === 'test--echo')!;
      const returned = JSON.parse(/\nIt returned: (.*)\n/.exec(resultText(r))![1]!) as unknown;
      assert.deepEqual(returned, { description: echo.description, inputSchema: echo.inputSchema });
    });
  });

  it('the host status counts scripts left running', async () => {
    const module = new ScriptToolModule();
    await withFramework('ce-status-', { module }, async (framework) => {
      framework.start();
      assert.equal(framework.getHostModeStatus().backgroundScripts, 0);
      await framework.executeToolCall({ id: 'ce-left', name: 'code_execution', input: { code: 'await tools["test--slow"]({});', yield_time_ms: 0 } });
      await until(() => framework.getHostModeStatus().backgroundScripts === 1, 'the left script counted');
      await until(() => module.waiting === 1, 'the slow call');
      module.release();
      await until(() => framework.getHostModeStatus().backgroundScripts === 0, 'the ended script uncounted');
    });
  });

  it("the host's settings reach its scripts: the bound, a call's timeout, the wake cap and the memory", async () => {
    const module = new ScriptToolModule();
    await withFramework('ce-settings-', { module, codeExecution: { yieldMs: 150, maxYieldMs: 150, toolCallTimeoutMs: 300, maxWakesPerScript: 1, wakeMinIntervalMs: 0, memoryMaxBytes: 8 * 1024 * 1024 } }, async (framework) => {
      framework.start();
      const tool = framework.getAllTools().find((t) => t.name === 'code_execution')!;
      assert.match(tool.description, /A script has 8 MiB of memory\./);
      const run = (input: Record<string, unknown>) => framework.executeToolCall({ id: `ce-${Math.random()}`, name: 'code_execution', input });
      /** A script run to its end, waiting as often as it yields. */
      const toEnd = async (code: string): Promise<string> => {
        let text = resultText(await run({ code }));
        const id = /^Script (s\d+-[0-9a-z]{4})/.exec(text)![1]!;
        for (let i = 0; i < 40 && / is still running /.test(text); i++) text = resultText(await run({ action: 'wait', script_id: id }));
        return text;
      };
      const yielded = await run({ code: 'await tools["test--slow"]({});', yield_time_ms: 60_000 });
      assert.match(resultText(yielded), /is still running after 150 ms\./, 'the bound asked is capped at maxYieldMs');
      await run({ action: 'stop', script_id: /^Script (s\d+-[0-9a-z]{4})/.exec(resultText(yielded))![1]! });
      assert.match(await toEnd('try { await tools["test--slow"]({}); } catch (e) { return e.name; }'), /It returned: "TimeoutError"/);
      assert.match(await toEnd('try { await wake_agent(1); } catch {} try { await wake_agent(2); } catch (e) { return e.message; }'), /It returned: "wake limit reached: 1 per script, set by the host's maxWakesPerScript; nothing was sent,/);
      // 16 MiB doesn't fit the 8 MiB set, where it would fit the default 128 MiB.
      assert.match(
        await toEnd('try { const keep = []; for (let i = 0; i < 16; i++) keep.push(new Uint8Array(1 << 20)); return "fit"; } catch (e) { return String(e); }'),
        /It returned: ".*out of memory/i,
      );
      while (module.release()) { /* free the calls left waiting */ }
    });
  });

  it("malformed code_execution inputs are refused, each saying what's wrong, with nothing run", async () => {
    await withFramework('ce-malformed-', {}, async (framework) => {
      framework.start();
      const run = (input: unknown) => framework.executeToolCall({ id: `ce-${Math.random()}`, name: 'code_execution', input: input as Record<string, unknown> });
      for (const [input, refusal] of [
        ['a string', /^code_execution takes an object/],
        [[1, 2], /^code_execution takes an object/],
        [{ code: 1 }, /a run needs `code`/],
        [{ code: '   ' }, /a run needs `code`/],
        [{ code: 'return 1;', yield_time_ms: -1 }, /yield_time_ms must be a whole number of milliseconds, 0 or more/],
        [{ code: 'return 1;', yield_time_ms: 1.5 }, /yield_time_ms must be a whole number/],
        [{ code: 'return 1;', yield_time_ms: '10' }, /yield_time_ms must be a whole number/],
        [{ action: 'nope' }, /unknown action "nope": run \(the default\), wait, stop or list/],
        [{ action: 'stop' }, /stop needs `script_id`/],
        [{ action: 'wait', script_id: 7 }, /wait needs `script_id`/],
      ] as const) {
        const r = await run(input);
        assert.equal(r.success, false, JSON.stringify(input));
        assert.match(r.error ?? '', refusal, JSON.stringify(input));
        assert.equal(r.refused, undefined, `${JSON.stringify(input)} is a failure, not the dispatcher's refusal`);
      }
      const scripts = (framework as unknown as { codeExecution: { scripts: { list(agent: string): unknown[] } } }).codeExecution.scripts;
      assert.deepEqual(scripts.list('__ephemeral__'), [], 'none of them ran a script');
    });
  });

  it("a turn that settles while the settling stream owns the agent ends its scripts' turn, and an exhausted one as abandoned", async () => {
    await withFramework('ce-settle-', {}, async (framework) => {
      const ended: Array<[string, unknown, boolean, string | undefined]> = [];
      const internals = framework as unknown as {
        codeExecution: unknown;
        settleAgent(agent: string, outcome: { stopReason: string; speech: string; error?: string }, closes: unknown): void;
      };
      const real = internals.codeExecution;
      internals.codeExecution = { scripts: { turnEnded: (agent: string, turn: unknown, abandoned: boolean, reason?: string) => { ended.push([agent, turn, abandoned, reason]); }, dispose: async () => {}, leftRunning: () => 0 } };
      try {
        internals.settleAgent('helper', { stopReason: 'turn_ended', speech: '' }, { turnId: 1 });
        internals.settleAgent('helper', { stopReason: 'exhausted', speech: '', error: 'Stream threw' }, { turnId: 2 });
        // A settle with no turn at all ends nothing.
        internals.settleAgent('helper', { stopReason: 'exhausted', speech: '', error: 'late' }, undefined);
      } finally {
        internals.codeExecution = real;
      }
      assert.deepEqual(ended, [['helper', { id: 1, live: [] }, false, undefined], ['helper', { id: 2, live: [] }, true, 'Stream threw']]);
    });
  });

  it('create() refuses a setting the Python runner took, naming what replaced it, and a switch that is not a boolean', async () => {
    const { tempDir, storePath } = tempStorePath('ce-config-');
    const create = (codeExecution: unknown) => AgentFramework.create({
      storePath, membrane: new MockMembrane().asMembrane(), agents: [], modules: [], syncIntervalMs: 0,
      codeExecution: codeExecution as never,
    });
    try {
      await assert.rejects(create({ enabled: true, pythonPath: '/usr/bin/python3' }), /codeExecution\.pythonPath is no longer read: scripts are JavaScript now/);
      // Refused before anything opened: its store was never made.
      assert.equal(existsSync(storePath), false);
      await assert.rejects(create({ enabled: true, scriptTimeoutMs: 1000 }), /codeExecution\.scriptTimeoutMs is no longer read: .*set yieldMs/);
      assert.equal(existsSync(storePath), false);
      await assert.rejects(create({ enabled: 'false' }), /codeExecution\.enabled must be true or false, unquoted, not a string/);
      assert.equal(existsSync(storePath), false);
      await assert.rejects(create(true), /codeExecution must be an object, such as \{ enabled: true \}, not a boolean/);
      assert.equal(existsSync(storePath), false);
      // Off: nothing else is read, so a retired setting in a configuration that's off is no refusal.
      for (const off of [null, false, { enabled: false, pythonPath: 'x' }, { enabled: null }]) {
        const framework = await create(off);
        try {
          assert.ok(!framework.getAllTools().some((t) => t.name === 'code_execution'));
        } finally {
          await framework.stop();
        }
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});


// ---------------------------------------------------------------------------
// A round that runs code_execution: the calls a script makes while a run or
// wait call of the round watches it count as the round's
// ---------------------------------------------------------------------------

describe('a round whose run or wait call watches a script that can change its routing is routed once that call returns', () => {
  /** echo, send_message, and `slow` and `gate`, each held until the test lets it go; each call is logged. */
  class RoundToolModule implements Module {
    readonly name = 'test';
    releaseSlow: () => void = () => {};
    releaseGate: () => void = () => {};
    releaseBatch: () => void = () => {};
    /** A send holds until the gate is released, as `gate` does. */
    holdSend = false;
    /** The batch-completion hook holds until releaseBatch. */
    holdBatch = false;
    private slowReleased = new Promise<void>((resolve) => { this.releaseSlow = resolve; });
    private gateReleased = new Promise<void>((resolve) => { this.releaseGate = resolve; });
    private batchReleased = new Promise<void>((resolve) => { this.releaseBatch = resolve; });
    constructor(private readonly log: string[]) {}
    async onToolBatchComplete(): Promise<void> {
      if (!this.holdBatch) return;
      this.log.push('hook:called');
      await this.batchReleased;
      this.log.push('hook:returned');
    }
    async start(_ctx: ModuleContext): Promise<void> {}
    async stop(): Promise<void> {}
    getTools(): ToolDefinition[] {
      const tool = (name: string): ToolDefinition => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
      return [tool('echo'), tool('send_message'), tool('slow'), tool('gate')];
    }
    async handleToolCall(call: ToolCall): Promise<ToolResult> {
      const name = call.name.includes('--') ? call.name.slice(call.name.lastIndexOf('--') + 2) : call.name;
      this.log.push(`tool:${name}`);
      if (name === 'slow') {
        await this.slowReleased;
        this.log.push('slow:returned');
      }
      if (name === 'gate') {
        await this.gateReleased;
        this.log.push('gate:returned');
      }
      if (name === 'send_message' && this.holdSend) {
        await this.gateReleased;
        this.log.push('send:returned');
      }
      return { success: true, data: { ok: true } };
    }
    async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
      return event.type === 'external-message'
        ? { addMessages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }], requestInference: true }
        : {};
    }
  }

  const CHANNEL_TOOLS = [
    { name: 'skip_reply', description: 'End your turn without sending anything.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'think', description: 'Reason privately.', inputSchema: { type: 'object' as const, properties: { content: { type: 'string' } } } },
    { name: 'channel_open', description: 'Open a channel.', inputSchema: { type: 'object' as const, properties: { channelId: { type: 'string' } } } },
  ];

  async function scriptRound(mode: 'locus' | 'hybrid' | 'explicit' | 'disabled', responses: ReturnType<typeof createMockResponse>[],
    config: { sameRoundThinkTextPolicy?: 'private'; allowedTools?: string[] } = {},
    options: { codeExecution?: boolean; toolCallTimeoutMs?: number; serveWakes?: boolean } = {}) {
    const { tempDir, storePath } = tempStorePath('ce-round-');
    const membrane = new MockMembrane();
    for (const response of responses) membrane.pushResponse(response);
    if (options.serveWakes) {
      const streamYielding = membrane.streamYielding.bind(membrane);
      (membrane as unknown as { streamYielding: typeof streamYielding }).streamYielding = (request, opts) => {
        const internals = membrane as unknown as { responses: unknown[]; responseIndex: number };
        if (internals.responseIndex >= internals.responses.length) membrane.pushResponse(createMockResponse([]));
        return streamYielding(request, opts);
      };
    }
    const log: string[] = [];
    const module = new RoundToolModule(log);
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Act.', proseRouting: mode, ...config }],
      modules: [module],
      syncIntervalMs: 0,
      ...(options.codeExecution === false ? {} : { codeExecution: { enabled: true, ...(options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs }) } }),
    });
    // Script ids s1-test, s2-test, …, so a later round's wait can name one.
    const scripts = (framework as unknown as { codeExecution: { scripts: { idTag: string } } | null }).codeExecution?.scripts;
    if (scripts) scripts.idTag = 'test';
    // The registry stub: skip_reply and think are on the agent's surface, so
    // its scripts get them too, and skip_reply ends the turn as the real one
    // does.
    // What each `>>` label names; a test can rename one while a script runs.
    const directory: Record<string, string> = { '#alpha': 'chan-alpha' };
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      // Every channel is the stub's server's: the framework names each with it.
      resolveLocus: () => ({ serverId: 'stub', channelId: 'world:test' }),
      resolveProseTarget: (spec: string) => (directory[spec] ? { serverId: 'stub', channelId: directory[spec] } : { error: `no channel ${spec}` }),
      routeSpeech: async (_agent: string, text: string, to: { channelId: string } | null) => {
        if (!to) return null;
        log.push(`publish:${text}@${to.channelId}`);
        return { delivered: true, serverId: 'stub', channelId: to.channelId };
      },
      // A named or sticky destination posts through deliverSpeech, as with
      // the real registry, which reports the post's outcome.
      deliverSpeech: async (_agent: string, text: string, to: { channelId: string } | null) => {
        if (!to) return { status: 'failed', reason: 'no channel', at: Date.now() };
        log.push(`publish:${text}@${to.channelId}`);
        return { status: 'delivered', destination: { serverId: 'stub', channelId: to.channelId }, at: Date.now() };
      },
      resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: 'stub', channelId } }),
      publish: async (_agent: string, text: string, to: { channelId: string }) => {
        log.push(`publish:${text}@${to.channelId}`);
        return { status: 'delivered', destination: { serverId: 'stub', channelId: to.channelId }, at: Date.now() };
      },
      // Each delivery hands its stream the destination its publish went to,
      // here the stub's server: a chunk for any other is logged with it, so
      // a delivery that loses its server fails the test.
      sendOutgoingChunk: (to: { serverId: string; channelId: string }, _agent: string, _id: string, _index: number, delta: string) => {
        log.push(`chunk:${delta}@${to.serverId === 'stub' ? to.channelId : `${to.channelId} (server ${to.serverId})`}`);
      },
      handleChannelToolCall: async (name: string, input: Record<string, unknown> | undefined) => {
        log.push(`tool:${name}`);
        if (name === 'skip_reply') return { success: true, endTurn: true, data: { skipped: true, note: 'Turn ended; nothing sent.' } };
        // A successful channel_open moves the turn's locus, as the real one does.
        if (name === 'channel_open') return { success: true, data: { channelId: input?.channelId, serverId: 'stub' } };
        return { success: true, data: {} };
      },
      getChannelTools: () => CHANNEL_TOOLS,
      getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined,
    }, { get: (target, key: string) => (key in target ? (target as Record<string, unknown>)[key] : () => undefined) });
    const run = async () => {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
      await framework.runUntilIdle();
    };
    const done = async () => {
      module.releaseSlow();
      module.releaseGate();
      module.releaseBatch();
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    };
    return { framework, module, log, run, done, directory };
  }

  const scriptCall = (input: Record<string, unknown>, id = 'ce1') =>
    ({ type: 'tool_use', id, name: 'code_execution', input }) as ContentBlock;
  /** The assistant's open drafts, oldest first, by their words and why each was held. */
  const heldDrafts = (framework: AgentFramework) =>
    (framework as unknown as { proseDrafts: { open(agent: string): Array<{ text: string; reason: string }> } })
      .proseDrafts.open('assistant').map((d) => ({ text: d.text, reason: d.reason })).reverse();
  /** Polls until `cond` holds, or a bound passes, so a run the code gets wrong still ends and fails its asserts. */
  const soon = async (cond: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  };
  type WatchedRun = {
    wait(ms: number): Promise<unknown>;
    call(id: number, name: string, args: string): Promise<void>;
    ended: boolean;
    hostCalls: number;
    snapshot(): { calls: { waiting: number } };
  };
  type WatchStep = {
    onWatch?: (run: WatchedRun) => void;
    yieldWhen?: (run: WatchedRun) => boolean;
    onReturn?: (returned: { running: boolean }) => void;
  };
  /**
   * Makes the run's own yield, the timer its yield_time_ms sets, come due once
   * `when` holds rather than on the clock. The timer is the runner's, set as
   * always; firing it early runs the runner's own callback, so ScriptRun.wait
   * and AgentScripts.observe return as at a yield. Left to come due, the timer
   * still ends a run the code gets wrong, so the test fails its asserts rather
   * than hangs: give the call a long yield_time_ms (60 s), which no event
   * waits on, so the clock never decides an order.
   */
  const yieldOnEvent = (run: WatchedRun, when: (run: WatchedRun) => boolean) => {
    const wait = run.wait;
    run.wait = (ms: number) => {
      run.wait = wait;
      const { result: waited, timers } = captureTimers(ms, () => wait.call(run, ms));
      // The runner yields through exactly one timer of the yield's length. If it
      // ever stops, this throws, rejecting the observing call, rather than leave
      // the test to the clock.
      if (timers.length !== 1) {
        throw new Error(run.ended
          ? "the run had ended before its wait, so there was no yield to fire"
          : `the run's wait set ${timers.length} timers of its ${ms} ms yield, not one`);
      }
      const poll = setInterval(() => {
        if (!when(run)) return;
        clearInterval(poll);
        fireTimer(timers[0]);
      }, 5);
      // The wait settles at the yield, or when the run ends: either way there is nothing left to fire.
      void waited.finally(() => clearInterval(poll));
      return waited;
    };
  };
  /**
   * Makes the timeouts of a run's calls to `tool` come due once `when` holds,
   * as yieldOnEvent does a yield: ScriptRun.call sets a call's timer before
   * it first awaits, so each call to `tool` runs under captureTimers, which
   * records the one timer of `ms`, the run's toolCallTimeoutMs. When `when`
   * holds it fires exactly `count` timers, or throws: fewer would leave the
   * rest to the clock, which still comes before the yield and would pass the
   * test on the clock's order. Left to come due, as at yieldOnEvent, the
   * timers still end a run the code gets wrong.
   */
  const timeOutOnEvent = (run: WatchedRun, tool: string, ms: number, count: number, when: () => boolean) => {
    const call = run.call;
    const timers: CapturedTimer[] = [];
    run.call = (id: number, name: string, args: string) => {
      if (name !== tool) return call.apply(run, [id, name, args]);
      const { result: called, timers: set } = captureTimers(ms, () => call.apply(run, [id, name, args]));
      // A call that set no such timer, or more than one, rejects the promise
      // the runner leaves unawaited (`void this.call(…)`), so the test fails on
      // the rejection, and the runner's frame loop goes on to the frames after
      // this one, as a throw here would stop it.
      if (set.length !== 1) return Promise.reject(new Error(`a call to ${tool} set ${set.length} timers of its ${ms} ms timeout, not one`));
      timers.push(set[0]);
      return called;
    };
    // The run's end clears its own timers (ScriptRun's callTimers), so the poll stops there too.
    const poll = setInterval(() => {
      if (run.ended) { clearInterval(poll); return; }
      if (!when()) return;
      clearInterval(poll);
      if (timers.length !== count) throw new Error(`${timers.length} calls to ${tool} had set their timeouts when they were to come due, not ${count}`);
      timers.forEach(fireTimer);
    }, 5);
  };
  /**
   * Steps the calls that watch a script, by their order (the first is the run,
   * the second the wait after it, …): a step's `onWatch` runs once its call
   * watches the script, its `yieldWhen` makes that call yield once it holds
   * (yieldOnEvent), and its `onReturn` gets what the call returned. Each order
   * a test needs then comes from events, not from margins on the clock.
   */
  const stepWatches = (framework: AgentFramework, steps: Array<WatchStep | undefined>) => {
    type Observe = (script: { run: WatchedRun }, ms: number, watch: unknown) => Promise<{ running: boolean }>;
    const scripts = (framework as unknown as { codeExecution: { scripts: { observe: Observe } } }).codeExecution.scripts;
    const observe = scripts.observe.bind(scripts);
    let n = 0;
    // A run's watch is set when its script is made, and a wait's just before it
    // observes, so a step's onWatch runs as its call starts watching. A stop
    // observes only once its stop has taken effect, and counts as a call here.
    scripts.observe = async (script, ms, watch) => {
      const step = steps[n++];
      step?.onWatch?.(script.run);
      if (step?.yieldWhen) yieldOnEvent(script.run, step.yieldWhen);
      const returned = await observe(script, ms, watch);
      step?.onReturn?.(returned);
      return returned;
    };
  };
  // A script holds its round only when it can change the round's routing:
  // its code names such a tool (scriptMayRoute). A script given this suffix
  // names skip_reply on a line that never runs, so its round waits for it.
  const HOLDS = '\nif (false) await tools.skip_reply({});';
  // An agent whose allowedTools leaves out skip_reply and send_message: its
  // scripts don't have them.
  const LISTED = { allowedTools: ['code_execution', 'test--echo', 'test--slow'] };
  /**
   * Sends `forged` through the bridge with the context of the script's call
   * of `test--slow`, as a child that ignores the tools it was given could:
   * the host's dispatch refuses it. Resolves once it's answered.
   */
  const forgeBeside = (framework: AgentFramework, forged: string, forgedArgs = '{}'): Promise<unknown> => {
    const bridge = framework as unknown as { scriptToolCall(agent: string, tool: string, args: string, context: unknown): Promise<unknown> };
    const real = bridge.scriptToolCall.bind(bridge);
    return new Promise((resolve) => {
      bridge.scriptToolCall = (agent, tool, args, context) => {
        if (tool === 'test--slow') void real(agent, forged, forgedArgs, context).then(resolve);
        return real(agent, tool, args, context);
      };
    });
  };

  for (const mode of ['locus', 'hybrid', 'explicit'] as const) {
    it(`${mode}: a skip_reply inside the script keeps its round's prose from delivery and the stream`, async () => {
      const prose = mode === 'explicit' ? '>>#alpha checking quietly' : 'checking quietly';
      const h = await scriptRound(mode, [
        createMockResponse([
          { type: 'text', text: prose },
          scriptCall({ code: 'await tools.skip_reply({});' }),
        ] as ContentBlock[], 'tool_use'),
      ]);
      try {
        await h.run();
        assert.ok(h.log.includes('tool:skip_reply'), 'the script called skip_reply');
        assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
          "the round's prose is kept, as a direct skip_reply keeps it");
      } finally { await h.done(); }
    });

    // With no EventGate, a skip_reply asking for a timed wake is refused, and
    // the turn goes on. Refused inside the script, it counts as a direct one:
    // its own round stays private, and the next round's prose is published.
    it(`${mode}: a skip_reply refused inside the script keeps only its own round private`, async () => {
      const kept = mode === 'explicit' ? '>>#alpha checking quietly' : 'checking quietly';
      const said = mode === 'explicit' ? '>>#alpha no timer here, so now' : 'no timer here, so now';
      const to = mode === 'explicit' ? 'chan-alpha' : 'world:test';
      const h = await scriptRound(mode, [
        createMockResponse([
          { type: 'text', text: kept },
          scriptCall({ code: 'try { await tools.skip_reply({ wake_in_seconds: 60 }); } catch (error) { text(error.name); }' }),
        ] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: said }] as ContentBlock[]),
      ]);
      try {
        await h.run();
        assert.ok(!h.log.includes('tool:skip_reply'), 'the host refused the call before the registry saw it');
        const published = h.log.filter((e) => e.startsWith('publish:'));
        assert.deepStrictEqual(published, [`publish:no timer here, so now@${to}`],
          "the refused call's round is kept, and the next round's prose is published");
        assert.ok(!h.log.some((e) => e.startsWith('chunk:checking quietly')), "nor does the kept round's prose stream");
      } finally { await h.done(); }
    });

    // A skip_reply the agent's allowedTools leaves out isn't among the
    // script's tools. A child that sends the call anyway is refused at
    // dispatch, and the call counts as a refused direct one does: its own
    // round stays private, and the next round's prose is published.
    it(`${mode}: a skip_reply sent past the script's tools, which the allowedTools refuses at dispatch, keeps only its own round private`, async () => {
      const kept = mode === 'explicit' ? '>>#alpha checking quietly' : 'checking quietly';
      const said = mode === 'explicit' ? '>>#alpha not mine to skip, so now' : 'not mine to skip, so now';
      const to = mode === 'explicit' ? 'chan-alpha' : 'world:test';
      const h = await scriptRound(mode, [
        createMockResponse([
          { type: 'text', text: kept },
          scriptCall({ code: 'await tools["test--slow"]({});' + HOLDS }),
        ] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: said }] as ContentBlock[]),
      ], LISTED);
      // The script's slow call goes once the forged call has its answer.
      let forged: { ok?: boolean; json?: string } | undefined;
      void forgeBeside(h.framework, 'skip_reply').then((answer) => { forged = answer as typeof forged; h.module.releaseSlow(); });
      const bound = setTimeout(() => h.module.releaseSlow(), 15000);
      try {
        await h.run();
        assert.equal(forged?.ok, false, 'the forged call was made, and refused');
        assert.equal(JSON.parse(forged?.json ?? '{}').name, 'ToolRefused');
        assert.ok(!h.log.includes('tool:skip_reply'), 'the host refused the call before the registry saw it');
        const published = h.log.filter((e) => e.startsWith('publish:'));
        assert.deepStrictEqual(published, [`publish:not mine to skip, so now@${to}`],
          "the refused call's round is kept, and the next round's prose is published");
        assert.ok(!h.log.some((e) => e.startsWith('chunk:checking quietly')), "nor does the kept round's prose stream");
        assert.deepStrictEqual(heldDrafts(h.framework), [], 'and nothing is held as a draft');
      } finally {
        clearTimeout(bound);
        await h.done();
      }
    });
  }

  it("a call of a tool the script doesn't have never leaves the script, so it counts for nothing", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'checking quietly' },
        scriptCall({ code: 'try { await tools.skip_reply({}); } catch (error) { text(error.message); }' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ], LISTED);
    try {
      await h.run();
      assert.ok(!h.log.includes('tool:skip_reply'), 'the script threw at the name, and nothing was sent');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')),
        ['publish:checking quietly@world:test', 'publish:done@world:test'], 'both rounds are published, as with no call at all');
    } finally { await h.done(); }
  });

  // A send the agent's allowedTools leaves out posted nothing, so, refused at
  // dispatch as a direct one would be, it silences nothing: its round and the
  // next are published, and nothing is held as a draft.
  for (const mode of ['locus', 'hybrid'] as const) it(`${mode}: a send sent past the script's tools, which the allowedTools refuses, silences nothing`, async () => {
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: 'posting the summary' },
        scriptCall({ code: 'await tools["test--slow"]({});' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ], LISTED);
    let forged: { ok?: boolean; json?: string } | undefined;
    void forgeBeside(h.framework, 'test--send_message').then((answer) => { forged = answer as typeof forged; h.module.releaseSlow(); });
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.equal(forged?.ok, false, 'the forged send was made, and refused');
      assert.equal(JSON.parse(forged?.json ?? '{}').name, 'ToolRefused');
      assert.ok(!h.log.includes('tool:send_message'), 'the host refused the send before the module saw it');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')),
        ['publish:posting the summary@world:test', 'publish:done@world:test'],
        'the round and the next are published, as with no send at all');
      assert.deepStrictEqual(heldDrafts(h.framework), [], 'and nothing is held as a draft');
    } finally {
      clearTimeout(bound);
      await h.done();
    }
  });

  for (const mode of ['locus', 'hybrid'] as const) it(`${mode}: a send inside the script silences its round and the turn's later prose`, async () => {
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: 'posting the summary' },
        scriptCall({ code: 'await tools["test--send_message"]({});' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message'), 'the script sent');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        'the send silences the round and what follows, as a direct send does');
      assert.deepStrictEqual(heldDrafts(h.framework), [
        { text: 'posting the summary', reason: 'explicit-send' },
        { text: 'done', reason: 'explicit-send' },
      ], 'and holds their words as drafts, as a direct send does');
    } finally { await h.done(); }
  });

  // A drafts resend is an explicit send, decided by what it posted, as
  // send_message is: called from the round's script too. This one names a
  // draft there isn't, so it's refused and posts nothing, and holds nothing.
  for (const mode of ['locus', 'hybrid'] as const) it(`${mode}: a drafts resend inside the script that posts nothing leaves its round's prose and the turn's later prose free`, async () => {
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: 'sending the earlier reply again' },
        scriptCall({ code: 'try { text(await tools.drafts({ action: "resend", draftIds: ["d-0000000"], destination: "#alpha" })); } catch (error) { text(error.message); }' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), [
        'publish:sending the earlier reply again@world:test',
        'publish:done@world:test',
      ]);
      assert.deepStrictEqual(heldDrafts(h.framework), []);
    } finally { await h.done(); }
  });

  // skip_reply's privacy outranks a send's hold, as for direct calls: a
  // round whose script calls both keeps its prose private, and holds no draft.
  for (const mode of ['locus', 'hybrid'] as const) it(`${mode}: a script that sends and calls skip_reply keeps its round's prose private, with no draft`, async () => {
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: 'posting the summary, then going quiet' },
        scriptCall({ code: 'await tools["test--send_message"]({});\nawait tools.skip_reply({});' }),
      ] as ContentBlock[], 'tool_use'),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message') && h.log.includes('tool:skip_reply'), 'the script sent and skipped');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [], 'nothing is published');
      assert.deepStrictEqual(heldDrafts(h.framework), [], 'and the round is kept private, not held as a draft');
    } finally { await h.done(); }
  });

  it("explicit: a drafts call inside the script holds its round's unprefixed line with no notice rather than bouncing it, as a direct one does (#701)", async () => {
    const h = await scriptRound('explicit', [
      createMockResponse([
        { type: 'text', text: 'checking my drafts' },
        scriptCall({ code: 'try { await tools.drafts({ action: "list" }); } catch {}' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: '>>#alpha the answer' }] as ContentBlock[]),
    ], {}, { serveWakes: true });
    try {
      await h.run();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:the answer@chan-alpha'],
        'the next round is delivered');
      assert.deepStrictEqual(heldDrafts(h.framework), [{ text: 'checking my drafts', reason: 'no-destination' }],
        "the drafts round's line is held, not bounced");
    } finally { await h.done(); }
  });

  it("explicit: a script whose only drafts call the bridge refuses makes no drafts round, so its round's unprefixed line bounces (#701)", async () => {
    const h = await scriptRound('explicit', [
      createMockResponse([
        { type: 'text', text: 'checking my drafts' },
        scriptCall({ code: 'try { await tools.drafts("not an object"); } catch {}' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: '>>#alpha the answer' }] as ContentBlock[]),
    ], {}, { serveWakes: true });
    try {
      await h.run();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:the answer@chan-alpha']);
      assert.deepStrictEqual(heldDrafts(h.framework), [{ text: 'checking my drafts', reason: 'bounced' }],
        'a refused drafts call counts for nothing, so the line bounces as on main');
    } finally { await h.done(); }
  });

  it("explicit: a drafts call the bridge refuses doesn't hide a later permitted one in the same script (#701)", async () => {
    const h = await scriptRound('explicit', [
      createMockResponse([
        { type: 'text', text: 'checking my drafts' },
        scriptCall({ code: 'try { await tools.drafts("not an object"); } catch {} try { await tools.drafts({ action: "list" }); } catch {}' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: '>>#alpha the answer' }] as ContentBlock[]),
    ], {}, { serveWakes: true });
    try {
      await h.run();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:the answer@chan-alpha']);
      assert.deepStrictEqual(heldDrafts(h.framework), [{ text: 'checking my drafts', reason: 'no-destination' }],
        'the permitted drafts call makes a drafts round, so the line is held, not bounced');
    } finally { await h.done(); }
  });

  it("explicit: a send inside the script silences neither its round nor the turn's later prose, as a direct send doesn't", async () => {
    const h = await scriptRound('explicit', [
      createMockResponse([
        { type: 'text', text: '>>#alpha posting the summary' },
        scriptCall({ code: 'await tools["test--send_message"]({});' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: '>>#alpha done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message'), 'the script sent');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [
        'publish:posting the summary@chan-alpha', 'chunk:posting the summary@chan-alpha',
        'publish:done@chan-alpha', 'chunk:\n\ndone@chan-alpha',
      ], "explicit mode's prefixed prose is deliberate, so a send doesn't silence it");
    } finally { await h.done(); }
  });

  for (const mode of ['locus', 'hybrid', 'explicit'] as const) it(`${mode}: a think inside the script holds its round back under the private same-round policy`, async () => {
    const prefix = mode === 'explicit' ? '>>#alpha ' : '';
    const target = mode === 'explicit' ? 'chan-alpha' : 'world:test';
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: `${prefix}working it through` },
        scriptCall({ code: 'await tools.think({ content: "notes" });' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: `${prefix}the answer` }] as ContentBlock[]),
    ], { sameRoundThinkTextPolicy: 'private' });
    try {
      await h.run();
      assert.ok(h.log.includes('tool:think'), 'the script called think');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), [`publish:the answer@${target}`],
        'the round beside the think stays private, as with a direct think, and the next round is delivered');
    } finally { await h.done(); }
  });

  it("the round's prose goes out once its script returns, not after a slow tool beside it", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'on it' },
        scriptCall({ code: 'text(JSON.stringify(await tools["test--echo"]({})));' + HOLDS }),
        { type: 'tool_use', id: 'slow1', name: 'test--slow', input: {} },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // Let the slow tool go once the round's prose has gone out, or after a
    // bound, so a round that waited for it still ends and fails the order.
    const watch = setInterval(() => { if (h.log.includes('publish:on it@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:on it@world:test') >= 0, 'the prose was delivered');
      assert.ok(at('tool:echo') >= 0, 'the script made its call');
      assert.ok(at('tool:echo') < at('publish:on it@world:test'), "it waited for the script's own call");
      assert.ok(at('publish:on it@world:test') < at('slow:returned'), 'and not for the slow tool beside it');
      assert.ok(at('publish:on it@world:test') < at('chunk:on it@world:test'), 'and its chunk followed its publish');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  /** Runs a one-script round whose prose should go out while its script waits in a slow call. */
  const publishedWhileScriptRuns = async (mode: 'locus' | 'explicit', code: string, config: { sameRoundThinkTextPolicy?: 'private' } = {}) => {
    const prefix = mode === 'explicit' ? '>>#alpha ' : '';
    const target = mode === 'explicit' ? 'chan-alpha' : 'world:test';
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: `${prefix}running the analysis` },
        scriptCall({ code }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: `${prefix}done` }] as ContentBlock[]),
    ], config);
    const published = `publish:running the analysis@${target}`;
    const watch = setInterval(() => { if (h.log.includes(published)) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at(published) >= 0, 'the prose was delivered');
      assert.ok(at(published) < at('slow:returned'), 'while the script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  };

  /** Runs a one-script round whose prose should wait for its script, which waits in a slow call: the round goes out once the script returns. */
  const heldUntilScriptReturns = async (code: string) => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'about to speak' },
        scriptCall({ code }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // Once the script is in its slow call, a round routed at its tool-calls
    // event has had its delivery queued long before; with the agent's queued
    // deliveries run, the round must still be unpublished. Then the call goes.
    let publishedWhileRunning: boolean | undefined;
    let checking = false;
    const watch = setInterval(() => {
      if (checking || !h.log.includes('tool:slow')) return;
      checking = true;
      const queued = (h.framework as unknown as { proseSpeechChains: Map<string, Promise<void>> }).proseSpeechChains.get('assistant');
      void Promise.resolve(queued).then(() => {}, () => {}).then(() => {
        publishedWhileRunning = h.log.includes('publish:about to speak@world:test');
        h.module.releaseSlow();
      });
    }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.equal(publishedWhileRunning, false, "the round wasn't published while its script ran");
      assert.ok(at('slow:returned') < at('publish:about to speak@world:test'), 'it went out once the script had returned');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  };

  it("a script whose code names no tool that changes routing doesn't hold its round: its prose goes out while the script runs", async () => {
    await publishedWhileScriptRuns('locus', 'await tools["test--slow"]({});');
  });

  it("a name inside a longer identifier, as say_hello, my_say or $say, doesn't hold its round", async () => {
    await publishedWhileScriptRuns('locus', 'const say_hello = 1, my_say = 2, $say = 3, say$ = 4, send_message_log = [];\nawait tools["test--slow"]({});');
  });

  it('a script whose code names a world utterance, as say, holds its round until it returns', async () => {
    await heldUntilScriptReturns('await tools["test--slow"]({});\nif (false) await tools["world--say"]({});');
  });

  // The reading is coarse: a name in a comment or a string holds the round
  // too, for no longer than its call's yield.
  it('a comment or a string that names a routing tool holds its round as a call would', async () => {
    await heldUntilScriptReturns('await tools["test--slow"]({}); // then skip_reply');
    await heldUntilScriptReturns('await tools["test--slow"]({}); const note = "say it later";');
  });

  it("explicit: a script that names only a send doesn't hold its round, since a send can't change an explicit round's routing", async () => {
    await publishedWhileScriptRuns('explicit', 'await tools["test--slow"]({});\nif (false) await tools["test--send_message"]({});');
  });

  it("under the public same-round policy, a script that calls think doesn't hold its round", async () => {
    await publishedWhileScriptRuns('locus', 'await tools.think({ content: "notes" });\nawait tools["test--slow"]({});');
  });

  it("disabled: a script that names skip_reply doesn't hold its round, since nothing is routed", async () => {
    const h = await scriptRound('disabled', [
      createMockResponse([
        { type: 'text', text: 'never routed' },
        scriptCall({ code: 'await tools["test--slow"]({});' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const rounds = (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds;
    let waitedOn: boolean | undefined;
    const watch = setInterval(() => {
      if (!h.log.includes('tool:slow')) return;
      clearInterval(watch);
      waitedOn = rounds.has('assistant');
      h.module.releaseSlow();
    }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.equal(waitedOn, false, 'no round waited on the script');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), [], 'and nothing was published');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it('a tool name a script builds at runtime goes unseen: its round is routed at its tool-calls event, as before scripts counted', async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'not held' },
        scriptCall({ code: 'const name = "skip" + "_reply";\nawait tools[name]({});' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('tool:skip_reply') >= 0, 'the script called skip_reply by a name it built');
      assert.ok(at('publish:not held@world:test') >= 0,
        "the round was published anyway: its code names no tool that changes routing, so it didn't wait for the skip_reply that would have kept it back");
    } finally { await h.done(); }
  });

  it("without code execution, a code_execution call holds nothing: its round is routed at its tool-calls event", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'not a script after all' },
        scriptCall({ code: 'await tools.skip_reply({});' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ], {}, { codeExecution: false });
    try {
      await h.run();
      assert.ok(h.log.includes('publish:not a script after all@world:test'),
        "the call is answered as an unknown tool, whose result settles no round, so the round doesn't wait for it");
    } finally { await h.done(); }
  });

  it("an agent whose allowedTools leaves out code_execution holds nothing on a code_execution call: its round is routed, not withheld", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'not mine to run' },
        scriptCall({ code: 'await tools.skip_reply({});' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ], { allowedTools: ['test--echo'] });
    try {
      await h.run();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')),
        ['publish:not mine to run@world:test', 'publish:done@world:test'],
        'the refused call runs no script, so its round is routed at its tool-calls event');
    } finally { await h.done(); }
  });

  // A run returns at its yield: its round waits no longer, and the calls its
  // script makes after it are no round's.
  it('a round whose script yields is routed at the yield, and the calls the script makes after it are no round\'s', async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'starting a watcher' },
        scriptCall({ code: 'await tools["test--slow"]({});\nawait tools["test--send_message"]({});', yield_time_ms: 100 }),
      ] as ContentBlock[], 'tool_use'),
      // The turn waits in a later round until the left script has sent, so
      // the send comes while the turn's later prose is still to come.
      createMockResponse([{ type: 'tool_use', id: 'gate1', name: 'test--gate', input: {} }] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // The script goes on, to its send, once its round has gone out; the turn goes on once it has sent.
    const watch = setInterval(() => {
      if (h.log.includes('publish:starting a watcher@world:test')) h.module.releaseSlow();
      if (h.log.includes('tool:send_message')) h.module.releaseGate();
    }, 10);
    const bound = setTimeout(() => { h.module.releaseSlow(); h.module.releaseGate(); }, 15000);
    try {
      await h.run();
      h.framework.start();
      await soon(() => h.log.includes('publish:done@world:test'));
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:starting a watcher@world:test') >= 0 && at('publish:starting a watcher@world:test') < at('slow:returned'),
        'the round went out at the yield, while the script ran on');
      assert.ok(at('tool:send_message') > at('slow:returned'), 'the script sent once it was left');
      assert.ok(at('tool:send_message') < at('publish:done@world:test'), "and before the turn's later prose");
      assert.ok(at('publish:done@world:test') >= 0, "which went out");
      assert.deepStrictEqual(heldDrafts(h.framework), [], "and the left script's send held nothing as a draft");
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a round with two code_execution calls waits for both: the first returns at once, and the second's later skip_reply still counts", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'two scripts at once' },
        scriptCall({ code: 'text("first");' + HOLDS }, 'ce1'),
        scriptCall({ code: 'await tools["test--slow"]({});\nawait tools.skip_reply({});' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
    ]);
    // Let the second script go once the first's result has come back.
    const results: string[] = [];
    h.framework.onTrace((event) => {
      if ((event.type === 'tool:completed' || event.type === 'tool:failed') && event.tool === 'code_execution') {
        results.push(event.callId);
        if (event.callId === 'ce1') h.module.releaseSlow();
      }
    });
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.deepStrictEqual(results, ['ce1', 'ce2'], "the first script's result came back while the second ran");
      assert.ok(h.log.includes('tool:skip_reply'), "the second script's skip_reply ran");
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        "the round waited for the second script too, so its skip_reply kept the round's prose");
    } finally {
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a left script's calls aren't the round's, even while a run of the round watches another script", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        scriptCall({ code: 'await tools["test--slow"]({});\nawait tools["test--send_message"]({});', yield_time_ms: 100 }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'still mine to say' },
        scriptCall({ code: 'await tools["test--gate"]({});' + HOLDS }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // The second round's script holds its round open until the left script has sent.
    const watch = setInterval(() => {
      if (h.log.includes('tool:gate')) h.module.releaseSlow();
      if (h.log.includes('tool:send_message')) h.module.releaseGate();
    }, 10);
    const bound = setTimeout(() => { h.module.releaseSlow(); h.module.releaseGate(); }, 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('tool:send_message') >= 0 && at('tool:send_message') < at('gate:returned'),
        'the left script sent while the round waited on its own script');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')),
        ['publish:still mine to say@world:test', 'publish:done@world:test'], "the left script's send didn't silence the round");
      assert.deepStrictEqual(heldDrafts(h.framework), [], 'nor hold anything as a draft');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a skip_reply a script makes while a later round's wait watches it keeps that round's prose private", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'starting' },
        scriptCall({ code: 'await tools["test--slow"]({});\nawait tools.skip_reply({});', yield_time_ms: 100 }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'waiting on it' },
        scriptCall({ action: 'wait', script_id: 's1-test' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'never reached' }] as ContentBlock[]),
    ]);
    // The script goes on once the wait watches it.
    // A premise check: the slow call is held until this onWatch, so the skip_reply can't have reached its tool unless
    // the hold failed. If it ever did, this fails, rather than the test passing on another order.
    let reachedBeforeWait: boolean | undefined;
    stepWatches(h.framework, [undefined, { onWatch: () => { reachedBeforeWait = h.log.includes('tool:skip_reply'); h.module.releaseSlow(); } }]);
    try {
      await h.run();
      assert.strictEqual(reachedBeforeWait, false, "the wait watched before the skip_reply reached its tool");
      assert.ok(h.log.includes('tool:skip_reply'), 'the script called skip_reply');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:starting@world:test'],
        "the first round went out at its run's yield, and the wait's round is kept, as a direct skip_reply would keep it");
      assert.ok(!h.log.some((e) => e.includes('waiting on it') || e.includes('never reached')), 'nothing of it streamed, and the turn ended there');
    } finally {
      await h.done();
    }
  });

  it("a wait on a script whose code names no routing tool doesn't hold its round, though another of the agent's scripts names one", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        scriptCall({ code: 'await tools["test--slow"]({});', yield_time_ms: 100 }, 'ce1'),
        // s2-test: its code names skip_reply, so a wait that read its code for s1-test's would hold.
        scriptCall({ code: 'text("other");' + HOLDS }, 'ce0'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'waiting on it' },
        scriptCall({ action: 'wait', script_id: 's1-test' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const watch = setInterval(() => { if (h.log.includes('publish:waiting on it@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:waiting on it@world:test') >= 0 && at('publish:waiting on it@world:test') < at('slow:returned'),
        "the wait's round went out while the script it watched ran");
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it('a stop holds nothing: its round is routed at its tool-calls event', async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        scriptCall({ code: 'await tools["test--slow"]({});\nawait tools.skip_reply({});', yield_time_ms: 100 }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'stopping it' },
        scriptCall({ action: 'stop', script_id: 's1-test' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // The stop returns only once its round's prose is out, or after a bound,
    // so a round that waited for it shows in the order.
    const scripts = (h.framework as unknown as { codeExecution: { scripts: { stop: (...args: unknown[]) => Promise<unknown> } } }).codeExecution.scripts;
    const stop = scripts.stop.bind(scripts);
    let releaseStop!: () => void;
    const stopHeld = new Promise<void>((resolve) => { releaseStop = resolve; });
    scripts.stop = async (...args) => { const r = await stop(...args); await stopHeld; h.log.push('stop:returned'); return r; };
    const watch = setInterval(() => { if (h.log.includes('publish:stopping it@world:test')) releaseStop(); }, 10);
    const bound = setTimeout(() => releaseStop(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:stopping it@world:test') >= 0 && at('publish:stopping it@world:test') < at('stop:returned'),
        "the stop's round went out before the stop returned");
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:stopping it@world:test', 'publish:done@world:test'],
        "the stop's round and the next are published");
      assert.ok(!h.log.includes('tool:skip_reply'), 'and the stopped script never called skip_reply');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a call the bridge refuses for its arguments still counts toward its round: a think given no object holds the round back under the private policy", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'working it through' },
        scriptCall({ code: 'try { await tools.think(null); } catch {}' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'the answer' }] as ContentBlock[]),
    ], { sameRoundThinkTextPolicy: 'private' });
    try {
      await h.run();
      assert.ok(!h.log.includes('tool:think'), 'the bridge refused it before dispatch');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:the answer@world:test'],
        'the round beside the think stays private, as with a direct think, and the next round is delivered');
    } finally { await h.done(); }
  });

  it('a send the bridge refuses for its arguments counts as one the allowedTools refuses: it silences nothing', async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'posting the summary' },
        scriptCall({ code: 'try { await tools["test--send_message"](null); } catch {}' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(!h.log.includes('tool:send_message'), 'the bridge refused it before dispatch');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:posting the summary@world:test', 'publish:done@world:test'],
        'the round and the next are published, as with no send at all');
    } finally { await h.done(); }
  });

  it('a skip_reply the bridge refuses for its arguments counts as a refused direct one: it keeps only its own round private', async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'checking quietly' },
        scriptCall({ code: 'try { await tools.skip_reply(null); } catch {}' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'no object given, so now' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(!h.log.includes('tool:skip_reply'), 'the bridge refused it before dispatch');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:no object given, so now@world:test'],
        "the refused call's round is kept, and the turn goes on to publish the next");
      assert.deepStrictEqual(heldDrafts(h.framework), [], 'and nothing is held as a draft');
    } finally { await h.done(); }
  });

  it("a call whose arguments aren't JSON still counts toward its round: such a think holds the round back under the private policy", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'working it through' },
        scriptCall({ code: 'await tools["test--slow"]({});' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'the answer' }] as ContentBlock[]),
    ], { sameRoundThinkTextPolicy: 'private' });
    // A child that ignores the prelude sends a think whose arguments aren't JSON, beside the script's slow call.
    let forged: { ok?: boolean; json?: string } | undefined;
    void forgeBeside(h.framework, 'think', '{not json').then((answer) => { forged = answer as typeof forged; h.module.releaseSlow(); });
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.equal(forged?.ok, false, 'the forged call was made, and refused');
      assert.match(JSON.parse(forged?.json ?? '{}').message ?? '', /weren't JSON/);
      assert.ok(!h.log.includes('tool:think'), 'the bridge refused it before dispatch');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:the answer@world:test'],
        'the round beside the think stays private, as with a direct think, and the next round is delivered');
    } finally {
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a start that resumes a turn its settle ended makes that turn live again while it runs", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([{ type: 'text', text: 'all done' }] as ContentBlock[]),
      createMockResponse([{ type: 'text', text: 'carrying on' }] as ContentBlock[]),
    ]);
    const fw = h.framework as unknown as {
      pendingRequests: Array<Record<string, unknown>>;
      turnRouting: Map<string, { turnId: number }>;
      settledTurns: WeakSet<object>;
      liveTurns(agent: string, ending: object | undefined): number[];
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await h.run();
      const settled = fw.turnRouting.get('assistant');
      assert.ok(settled && fw.settledTurns.has(settled), 'the turn settled');
      assert.deepEqual(fw.liveTurns('assistant', undefined), [], 'and is no longer live');
      // A silent budget restart resumes the agent's latest routing, the one
      // that settled: while it runs, holding the agent's turn, that turn is live,
      // so a non-primary agent's run made in it starts.
      let live: number[] | undefined;
      const off = h.framework.onTrace((event) => {
        if (event.type === 'inference:started' && live === undefined) live = fw.liveTurns('assistant', undefined);
      });
      fw.pendingRequests.push({ agentName: 'assistant', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now(), suppressProse: true });
      void h.framework.runUntilIdle().catch(() => {});
      await new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => { if (live !== undefined) { clearInterval(poll); resolve(); } }, 10);
        timer = setTimeout(() => { clearInterval(poll); reject(new Error('the resumed start never began')); }, 30_000);
      });
      off();
      assert.equal(fw.turnRouting.get('assistant'), settled, 'the restart runs on that routing');
      assert.deepEqual(live, [settled!.turnId]);
    } finally {
      clearTimeout(timer);
      await h.done();
    }
  });

  it('a send counts toward its round once the host has it, though its tool is still running when the run yields', async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'posting the summary' },
        // The send is held, and the run yields once the send has reached its tool.
        scriptCall({ code: 'await tools["test--send_message"]({});', yield_time_ms: 60_000 }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    h.module.holdSend = true;
    let returned: { running: boolean } | undefined;
    stepWatches(h.framework, [{ yieldWhen: () => h.log.includes('tool:send_message'), onReturn: (r) => { returned = r; } }]);
    // The send goes on once the turn is over (h.done).
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message'), 'the send reached its tool');
      assert.strictEqual(returned?.running, true, 'and the run returned at its yield, its script still in the send');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), [], 'the send silenced the round and the turn after it');
    } finally {
      await h.done();
    }
  });

  it("a call made while a run watches, that waits for room in the host until the run has yielded, counts toward the later wait's round, not the run's", async () => {
    // Esther-2584's probe: what counts is the host's receipt of a call, not the script's making it. The script's 16 slow
    // calls time out in it while their tools still hold the host's 16 places, so its skip_reply, made while the run
    // watches, waits for room in the host (the script itself sends at most 16 calls at once). The slow calls' timeouts
    // come due once all 16 have reached their tool, the run yields once the skip_reply waits, and the slow calls go once
    // the wait watches, so the host receives the skip_reply while the wait watches, and the wait returns once the script
    // ends. Each step waits for the one before it, not for the clock: the 59 s timeout and 60 s yield can't come due
    // first. Each capture records only timers set inside its own call; the lengths differ too, so neither could take the
    // other's timer even if one call ever set both.
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'starting' },
        scriptCall({ code: [
          'const slow = Array.from({ length: 16 }, () => tools["test--slow"]({}).catch((e) => e.name));',
          'await Promise.all(slow);',
          'await tools.skip_reply({});',
        ].join('\n'), yield_time_ms: 60_000 }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'waiting on it' },
        scriptCall({ action: 'wait', script_id: 's1-test' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'never reached' }] as ContentBlock[]),
    ], {}, { toolCallTimeoutMs: 59_000 });
    // skipReplyReached and slowReturned are premise checks: the slow tools hold until the wait's onWatch releases them,
    // so both are false unless the hold failed, and if it ever did, these fail rather than the test passing on another order.
    let atWait: { waiting: number; hostCalls: number; skipReplyReached: boolean; slowReturned: boolean } | null = null;
    stepWatches(h.framework, [
      {
        onWatch: (run) => timeOutOnEvent(run, 'test--slow', 59_000, 16, () => h.log.filter((e) => e === 'tool:slow').length === 16),
        // The run yields once its skip_reply waits for room, the 16 places taken.
        yieldWhen: (run) => run.snapshot().calls.waiting === 1 && run.hostCalls === 16,
      },
      // The slow calls go once the wait watches.
      {
        onWatch: (run) => {
          atWait = {
            waiting: run.snapshot().calls.waiting,
            hostCalls: run.hostCalls,
            skipReplyReached: h.log.includes('tool:skip_reply'),
            slowReturned: h.log.includes('slow:returned'),
          };
          h.module.releaseSlow();
        },
      },
    ]);
    try {
      await h.run();
      assert.deepStrictEqual(atWait, { waiting: 1, hostCalls: 16, skipReplyReached: false, slowReturned: false },
        "as the wait began, the skip_reply waited for room, the 16 places taken: it hadn't reached its tool, and no slow tool had returned");
      // The run's round went out, and the skip_reply reached its tool only after it.
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:starting@world:test']);
      assert.ok(h.log.indexOf('tool:skip_reply') > h.log.indexOf('publish:starting@world:test'), h.log.join(' | '));
      // The wait's round was kept private, and the turn ended there.
      assert.ok(!h.log.some((e) => e.includes('waiting on it') || e.includes('never reached')), h.log.join(' | '));
    } finally {
      await h.done();
    }
  });

  it("a round's prose is routed before the tool-result handler awaits a module's batch-completion hook", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'on it' },
        scriptCall({ code: 'text("x");' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    h.module.holdBatch = true;
    const watch = setInterval(() => { if (h.log.includes('publish:on it@world:test')) h.module.releaseBatch(); }, 10);
    const bound = setTimeout(() => h.module.releaseBatch(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('hook:called') >= 0, 'the hook ran for the batch');
      assert.ok(at('publish:on it@world:test') >= 0 && at('publish:on it@world:test') < at('hook:returned'), 'the round went out while the hook held');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a model's code_execution call whose input isn't an object holds nothing and throws nothing: its round's prose goes out", async () => {
    for (const input of [null, 'run it']) {
      const h = await scriptRound('locus', [
        createMockResponse([
          { type: 'text', text: 'trying it' },
          { type: 'tool_use', id: 'ce1', name: 'code_execution', input } as unknown as ContentBlock,
        ] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
      ]);
      try {
        await h.run();
        assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:trying it@world:test', 'publish:done@world:test'], String(input));
      } finally { await h.done(); }
    }
  });

  it("a name a Unicode letter or a joiner continues isn't the tool's name", async () => {
    await publishedWhileScriptRuns('locus', 'await tools["test--slow"]({}); // πsay sayπ say\u200D \u200Csay say\u00E9');
  });

  it('a script whose code names whisper holds its round until it returns', async () => {
    await heldUntilScriptReturns('await tools["test--slow"]({});\nif (false) await tools["world--whisper"]({});');
  });

  it("a script that makes many calls of one kind keeps one entry for them in its round's count", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'counting' },
        scriptCall({ code: 'for (let i = 0; i < 40; i++) await tools["test--echo"]({});\nawait tools["test--gate"]({});' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const rounds = (h.framework as unknown as { scriptRounds: Map<string, { scripts: Map<string, unknown[]> }> }).scriptRounds;
    let kept: number | undefined;
    const watch = setInterval(() => {
      if (kept !== undefined || !h.log.includes('tool:gate')) return;
      kept = rounds.get('assistant')?.scripts.get('ce1')?.length;
      h.module.releaseGate();
    }, 10);
    const bound = setTimeout(() => h.module.releaseGate(), 15000);
    try {
      await h.run();
      assert.equal(h.log.filter((e) => e === 'tool:echo').length, 40, 'every call went out');
      assert.equal(kept, 2, 'one echo and one gate, while the round still waited');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a drafts list and then a resend in one script are both kept in its round's count: the resend still silences the turn's later prose", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'checking the drafts, then sending one' },
        scriptCall({ code: 'const listed = await tools.drafts({ action: "list" });\nconst id = /d-[a-z2-9]{7}/.exec(JSON.stringify(listed))[0];\nawait tools.drafts({ action: "resend", draftIds: [id], destination: "#here" });' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    h.directory['#here'] = 'world:test';
    (h.framework as unknown as { proseDrafts: { hold(agent: string, texts: Array<{ text: string }>, reason: string): unknown } })
      .proseDrafts.hold('assistant', [{ text: 'earlier words' }], 'explicit-send');
    try {
      await h.run();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:earlier words@world:test'],
        'the resend posts where the round speaks, and silences the round and what follows, though a call of the same tool that sends nothing came first');
      assert.deepStrictEqual(heldDrafts(h.framework), [
        { text: 'done', reason: 'explicit-send' },
      ], "the later prose is held, so the resend was counted; the drafts round's own prose is kept private (#701)");
    } finally { await h.done(); }
  });

  it("a round that waits counts the calls of a script it doesn't wait on: a skip_reply by a name built at runtime keeps it private", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'two at once' },
        scriptCall({ code: 'await tools["test--gate"]({}); // and maybe skip_reply' }, 'ce1'),
        scriptCall({ code: 'await tools["skip" + "_reply"]({});' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'never reached' }] as ContentBlock[]),
    ]);
    // The waited-on script goes on once the other's skip_reply has reached the host.
    const watch = setInterval(() => { if (h.log.includes('tool:skip_reply')) h.module.releaseGate(); }, 10);
    const bound = setTimeout(() => h.module.releaseGate(), 15000);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:skip_reply'), 'the second script called skip_reply');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        'the round, waiting on the first script, counted the second\'s skip_reply and kept its prose');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("locus: a script round's prose goes to the locus it was written for, though the script opens another channel", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'for the room I was in' },
        scriptCall({ code: 'await tools.channel_open({ channelId: "chan-other" });' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'now over here' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), [
        'publish:for the room I was in@world:test',
        'publish:now over here@chan-other',
      ], 'the open moves later prose, not the round written before it');
    } finally { await h.done(); }
  });

  it("an ephemeral disposed while its round's script runs doesn't publish the round when the script's call returns", async () => {
    const h = await scriptRound('locus', []);
    const membrane = (h.framework as unknown as { membrane: MockMembrane }).membrane;
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'never decided' },
      scriptCall({ code: 'await tools["test--slow"]({});' + HOLDS }),
    ] as ContentBlock[], 'tool_use'));
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); error(...args); };
    let resulted = false;
    h.framework.onTrace((event) => {
      if ((event.type === 'tool:completed' || event.type === 'tool:failed') && event.tool === 'code_execution') resulted = true;
    });
    try {
      const created = await h.framework.createEphemeralAgent({ name: 'eph-script', model: 'test-model', systemPrompt: 'Act.', allowedTools: 'all' });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'go' }]);
      // The idle watchdog disposes the ephemeral while its script waits in the
      // slow call: the run is made to look idle only once the script is in the
      // slow call, and the next poll disposes it.
      const run = h.framework.runEphemeralToCompletion(created.agent, created.contextManager, { ...UNREACHED_WATCHDOG, startupTimeoutMs: 15000 });
      const stalled = assert.rejects(run, /stalled/);
      h.framework.start();
      await soon(() => h.log.includes('tool:slow'));
      assert.ok(h.log.includes('tool:slow'), 'the script reached the slow call');
      silenceRun(h.framework, created.agent.name);
      await stalled;
      // The agent's end stops its script, and the run call returns with the framework still running.
      h.module.releaseSlow();
      await soon(() => resulted);
      assert.ok(resulted, "the script's run call returned");
      await h.framework.runUntilIdle();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        "the round's routing was never decided, so the late result publishes nothing");
      assert.ok(lines.some((line) => line.includes('eph-script: round [code_execution] -> 1 prose segment(s) withheld: its stream ended before its scripts returned')),
        "the disposed ephemeral's stream withheld the round as it ended");
    } finally {
      console.error = error;
      await h.done();
    }
  });

  // Each way a stream can stop owning its round while the round's script runs:
  // the agent stops waiting on it, is deregistered, or moves to a newer stream.
  const leaveRound: Record<string, (framework: AgentFramework, agent: { reset(): void }) => void> = {
    'its agent is reset': (_framework, agent) => agent.reset(),
    'its agent is deregistered': (framework) => {
      (framework as unknown as { agents: Map<string, unknown> }).agents.delete('assistant');
    },
    'its agent moves to a newer stream': (_framework, agent) => {
      (agent as unknown as { _streamId: number })._streamId++;
    },
  };
  for (const [how, leave] of Object.entries(leaveRound)) it(`a round is withheld when its script's call returns if, meanwhile, ${how}`, async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'never decided' },
        scriptCall({ code: 'await tools["test--slow"]({});' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
    ]);
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); error(...args); };
    let stream: { cancel(): void } | undefined;
    let agent: { state: { stream?: { cancel(): void } }; reset(): void } | undefined;
    try {
      h.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
      void h.framework.runUntilIdle().catch(() => {});
      await soon(() => h.log.includes('tool:slow'));
      assert.ok(h.log.includes('tool:slow'), 'the script reached its slow call');
      // The turn's routing state, whose receipt counts what the turn suppressed.
      const routing = (h.framework as unknown as { turnRouting: Map<string, { suppressed: number; drafts: unknown[] }> }).turnRouting.get('assistant')!;
      const suppressedBefore = routing.suppressed;
      // The stream no longer owns the round, while it lives on.
      agent = h.framework.getAgent('assistant')! as unknown as { state: { stream?: { cancel(): void } }; reset(): void };
      stream = agent.state.stream;
      leave(h.framework, agent);
      let resulted = false;
      h.framework.onTrace((event) => {
        if ((event.type === 'tool:completed' || event.type === 'tool:failed') && event.tool === 'code_execution') resulted = true;
      });
      h.module.releaseSlow();
      await soon(() => resulted);
      await soon(() => lines.some((line) => line.includes('prose segment(s) withheld')));
      assert.ok(lines.some((line) => line.includes('assistant: round [code_execution] -> 1 prose segment(s) withheld: its turn no longer waits on it')),
        "the script's call found the round undecidable and withheld it");
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [], 'and published nothing');
      assert.equal(routing.suppressed, suppressedBefore + 1, "and the turn's receipt counts the withheld segment as suppressed");
      assert.deepStrictEqual(routing.drafts, [], 'and holds none of it as a draft, since the script might have kept it private');
    } finally {
      console.error = error;
      stream?.cancel();
      // The departures are simulated, without the bookkeeping a real one does:
      // a real deregistration also clears the name's active stream, and a real
      // newer stream takes that entry over and clears it when it ends. Clear
      // it and settle the agent, so the loop this test started finds the
      // framework idle and the file can exit.
      (h.framework as unknown as { activeStreams: Map<string, unknown> }).activeStreams.delete('assistant');
      agent?.reset();
      await h.done();
    }
  });

  it("a round whose stream is stopped before its script's call returns is withheld", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'never decided' },
        scriptCall({ code: 'await tools["test--slow"]({});\nawait tools.skip_reply({});' }),
      ] as ContentBlock[], 'tool_use'),
    ]);
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); error(...args); };
    try {
      h.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
      void h.framework.runUntilIdle().catch(() => {});
      // The script is running, held in its slow call.
      await soon(() => h.log.includes('tool:slow'));
      assert.ok(h.log.includes('tool:slow'), 'the script reached its slow call');
      await h.framework.stop();
      h.module.releaseSlow();
      await new Promise((r) => setTimeout(r, 50));
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        "whether the script would have silenced the round is unknown, so its prose isn't sent");
      assert.ok(lines.some((line) => line.includes('1 prose segment(s) withheld: its stream ended before its scripts returned')),
        'and the withheld round is logged, not dropped silently');
    } finally {
      console.error = error;
      await h.done();
    }
  });

  /** A pending round of another stream, as scriptRounds holds one: it records what it was asked to do. */
  const pendingRound = (agent: unknown, pending: string[] = ['elsewhere']) => {
    const asked: string[] = [];
    return {
      asked,
      round: {
        agent, streamId: -1, scripts: new Map<string, string[]>(), pending: new Set(pending), sends: new Map(),
        route: () => { asked.push('route'); },
        withhold: (why: string) => { asked.push(`withhold: ${why}`); },
      },
    };
  };

  it("a script call's result settles only the round that dispatched it, though a newer round waits on the same call id", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'the first round' },
        scriptCall({ code: 'await tools["test--slow"]({});' + HOLDS }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const rounds = (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds;
    // While the script runs, a newer round comes to wait under the name on a
    // call with the same id, as a provider that reuses ids could make one.
    const newer = pendingRound(h.framework.getAgent('assistant'), ['ce1']);
    let swapped = false;
    const watch = setInterval(() => {
      if (!h.log.includes('tool:slow')) return;
      clearInterval(watch);
      rounds.set('assistant', newer.round);
      swapped = true;
      h.module.releaseSlow();
    }, 10);
    // A script that never reaches its slow call still ends, and fails below.
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.ok(swapped, 'the newer round came to wait while the script ran');
      assert.deepStrictEqual(newer.asked, [], "the first round's result doesn't settle the newer round");
      assert.equal(rounds.get('assistant'), newer.round, 'which still waits');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a newer round that doesn't wait displaces an older waiting round, so a call of its own with the same id can't settle it", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'the newer round' },
        scriptCall({ code: 'text("quick");' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // An older round of another stream still waits on a call with the same
    // id, as a provider that reuses ids could leave one.
    const older = pendingRound({}, ['ce1']);
    (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds.set('assistant', older.round);
    try {
      await h.run();
      assert.deepStrictEqual(older.asked, ['withhold: a newer round replaced it before its scripts returned'],
        "the older round is withheld, and the newer round's result settles nothing of it");
      assert.ok(h.log.includes('publish:the newer round@world:test'), 'and the newer round is routed at once');
    } finally { await h.done(); }
  });

  it('a round registered while another waits under the same agent name withholds the older one', async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'the newer round' },
        scriptCall({ code: 'text("quick");' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const older = pendingRound({});
    (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds.set('assistant', older.round);
    try {
      await h.run();
      assert.deepStrictEqual(older.asked, ['withhold: a newer round replaced it before its scripts returned'],
        'the older round is withheld, not overwritten silently');
      assert.ok(h.log.includes('publish:the newer round@world:test'), 'and the newer round is routed as usual');
    } finally { await h.done(); }
  });

  // A successor's round comes to wait under the agent's name while this stream
  // runs: one of another agent object of the name, or one of the same agent
  // object's later stream (a restart overlapping this one).
  for (const whose of ['another agent object', "the same agent object's later stream"] as const) {
    it(`a stream's teardown leaves alone a round that belongs to ${whose}`, async () => {
      const h = await scriptRound('locus', [
        createMockResponse([
          { type: 'text', text: 'working' },
          { type: 'tool_use', id: 'r1', name: 'test--echo', input: {} },
        ] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
      ]);
      // pendingRound's round has stream id -1, which no stream has: the later
      // stream's case. Another agent object's round takes this stream's own
      // id, so only the agent check tells it apart.
      const successor = pendingRound(whose === 'another agent object' ? {} : h.framework.getAgent('assistant'));
      const rounds = (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds;
      h.framework.onTrace((event) => {
        if (event.type !== 'tool:completed' || event.callId !== 'r1') return;
        if (whose === 'another agent object') successor.round.streamId = (h.framework.getAgent('assistant') as unknown as { streamId: number }).streamId;
        rounds.set('assistant', successor.round);
      });
      try {
        await h.run();
        assert.ok(h.log.includes('publish:done@world:test'), 'the stream ran to its end');
        assert.deepStrictEqual(successor.asked, [], "this stream's teardown doesn't withhold the successor's round");
        assert.equal(rounds.get('assistant'), successor.round, 'nor remove it');
      } finally { await h.done(); }
    });
  }

  it("explicit: a script round goes to the target its `>>` named when the round ended, though the label is renamed while the script runs", async () => {
    const h = await scriptRound('explicit', [
      createMockResponse([
        { type: 'text', text: '>>#alpha written for alpha' },
        scriptCall({ code: 'await tools["test--slow"]({});' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: '>>skip_reply done' }] as ContentBlock[]),
    ]);
    // While the script waits in its slow call, #alpha comes to name another channel.
    const watch = setInterval(() => {
      if (h.log.includes('tool:slow')) { h.directory['#alpha'] = 'chan-renamed'; h.module.releaseSlow(); }
    }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:written for alpha@chan-alpha'],
        'the round was admitted when it ended');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });
});

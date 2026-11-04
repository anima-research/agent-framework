/**
 * ToolCall.resultMaxChars: how long a call's result may be and still reach its
 * caller whole. A model's call gets the agent's inline cap as the store applies
 * it, so a result that long is stored whole while its round fits the readers'
 * bound and no save_recent_image in the round counted it by its share, and one
 * a character longer isn't.
 * A call from a running script gets the longest result that reaches the
 * script whole whatever its characters, from the script's memory (a
 * structured value, a deep nesting or a parse past the memory left can
 * still not reach it), and a call for an agent the framework
 * doesn't hold gets the house default. A call made in process carries what its
 * caller put on it, and a utility run through `utils` carries what its `utils`
 * call did.
 */

import { constants as bufferConstants } from 'node:buffer';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EventResponse,
  Module,
  ProcessEvent,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework, PassthroughStrategy } from '../src/index.js';
import { DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS } from '../src/tool-result-history.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

/** The residence's cap, and the strategy's bound beneath it (1000 tokens, 4 characters each). */
const CONFIGURED = 5000;
const BOUNDED = 4000;

class BoundedStrategy extends PassthroughStrategy {
  readonly maxMessageTokens = 1000;
}

/**
 * Records each call. `look` with `over` answers a text `over` characters past
 * the call's resultMaxChars, and with `fill` a text of exactly that many NUL
 * characters (`over` more with it), each six bytes once escaped in JSON;
 * without either, a short text. `peek` is a utility.
 */
class ProbeModule implements Module {
  readonly name = 'probe';
  calls: ToolCall[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{
      name: 'look',
      description: 'Answers at a given length.',
      inputSchema: { type: 'object', properties: { over: { type: 'number' } } },
    }];
  }
  getUtilities(): ToolDefinition[] {
    return [{ name: 'peek', description: 'A utility.', inputSchema: { type: 'object' } }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    const { over, fill } = (call.input ?? {}) as { over?: number; fill?: boolean };
    const text = fill ? '\u0000'.repeat((call.resultMaxChars ?? 0) + (over ?? 0))
      : over === undefined ? 'ok' : 'x'.repeat((call.resultMaxChars ?? 0) + over);
    return { success: true, data: [{ type: 'text', text }] };
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }],
        requestInference: true,
      };
    }
    return {};
  }
}

async function makeFramework(membrane: MockMembrane = new MockMembrane(), codeExecution?: { enabled: true; memoryMaxBytes: number }): Promise<{
  framework: AgentFramework;
  probe: ProbeModule;
  done: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'result-max-chars-'));
  const probe = new ProbeModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'prime',
      model: 'test-model',
      systemPrompt: 'You are prime.',
      allowedTools: 'all',
      strategy: new BoundedStrategy() as never,
    }],
    modules: [probe],
    syncIntervalMs: 0,
    toolResultInlineMaxChars: CONFIGURED,
    ...(codeExecution ? { codeExecution } : {}),
  });
  framework.start();
  return {
    framework,
    probe,
    done: async () => {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Waits for `check` to return a value, or fails after 20 s. */
async function until<T>(what: string, check: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The agent's stored tool results, by the id of the call each answers. */
function storedResults(framework: AgentFramework): Map<string, string> {
  const messages = (framework.getAgent('prime')?.getContextManager().queryMessages({}).messages ?? []) as unknown as Array<{
    content: Array<{ type: string; toolUseId?: string; content?: unknown }>;
  }>;
  const results = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool_result' && block.toolUseId) results.set(block.toolUseId, block.content as string);
    }
  }
  return results;
}

/** Opens the host's built-in toolset, where module utilities are, for the agent. */
async function openSettings(framework: AgentFramework): Promise<void> {
  const opened = await framework.executeToolCall({ id: 'open-settings', name: 'toolsets--open', input: { toolset: 'settings' }, callerAgentName: 'prime' });
  assert.ok(opened.success, opened.error);
}

describe('ToolCall.resultMaxChars', () => {
  it("a model's call carries the agent's inline cap, under which its result is stored whole while its round fits the bound", async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_at', name: 'probe--look', input: { over: 0 } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_past', name: 'probe--look', input: { over: 1 } },
      { type: 'tool_use', id: 'call_utility', name: 'toolsets--act', input: { tool: 'probe--peek', args: {} } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    const { framework, probe, done } = await makeFramework(membrane);
    try {
      await openSettings(framework);
      framework.pushEvent({
        type: 'external-message',
        source: 'test',
        content: [{ type: 'text', text: 'look' }],
        metadata: {},
        triggerInference: true,
      } as unknown as ProcessEvent);
      const stored = await until('the three stored results', () => {
        const results = storedResults(framework);
        return results.size >= 3 ? results : undefined;
      });

      const caps = new Map(probe.calls.map((call) => [call.id, call.resultMaxChars]));
      // The strategy's bound, not the residence's cap or the default.
      assert.equal(caps.get('call_at'), BOUNDED);
      assert.equal(caps.get('call_past'), BOUNDED);
      assert.equal(stored.get('call_at'), 'x'.repeat(BOUNDED), 'a result of resultMaxChars is stored whole');
      // call_past's round, beside the utility's short result, fits the bound,
      // so each is stored as it would be alone. This framework has no
      // workspace to spill to, so the store keeps the start.
      const past = stored.get('call_past')!;
      const kept = /^x*/.exec(past)![0].length;
      assert.ok(kept > 0 && kept < BOUNDED + 1, `one character more is cut to its start: kept ${kept}`);
      assert.equal(past,
        `${'x'.repeat(kept)}\n\n[truncated — original was ${BOUNDED + 1} chars; no writable workspace mount without an include, full content not retained]`,
        'its notice follows the start');
      assert.ok(past.length <= BOUNDED, `what is stored fits the cap: ${past.length}`);
      // A utility run through toolsets--act is stored as that call's result.
      assert.equal(caps.get('call_utility'), BOUNDED);
      assert.equal(probe.calls.find((call) => call.id === 'call_utility')?.name, 'peek');
    } finally {
      await done();
    }
  });

  it("the admin puppet's call carries the agent's inline cap, and so does a utility it runs", async () => {
    const { framework, probe, done } = await makeFramework();
    try {
      const { toolUseId } = await framework.puppetToolCall('prime', 'probe--look', {});
      assert.equal(probe.calls.find((call) => call.id === toolUseId)?.resultMaxChars, BOUNDED);
      await openSettings(framework);
      const utility = await framework.puppetToolCall('prime', 'toolsets--act', { tool: 'probe--peek', args: {} });
      const peek = probe.calls.find((call) => call.id === utility.toolUseId);
      assert.equal(peek?.name, 'peek');
      assert.equal(peek?.resultMaxChars, BOUNDED, 'the utility is stored under the cap the puppet stores the pair under');
    } finally {
      await done();
    }
  });

  it("a call from a running script carries the longest result that reaches the script whole whatever its characters, from its memory, and a utility it runs carries the same", async () => {
    // The script's answer, a text's JSON in an envelope of 80 bytes, may take
    // a third of its memory, and a character of the text at most six bytes there.
    const memoryMaxBytes = 8 * 1024 * 1024;
    const limit = Math.floor((Math.floor(memoryMaxBytes / 3) - 80) / 6);
    const { framework, probe, done } = await makeFramework(new MockMembrane(), { enabled: true, memoryMaxBytes });
    try {
      await openSettings(framework);
      const result = await framework.executeToolCall({
        id: 'script', name: 'code_execution', callerAgentName: 'prime', input: { code: [
          'const r = await tools["probe--look"]({ fill: true });',
          'await tools["toolsets--act"]({ tool: "probe--peek", args: {} });',
          'const t = r.content[0].text;',
          'let nul = true;',
          'for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) !== 0) { nul = false; break; }',
          'return [t.length, nul, r.isError];',
        ].join('\n') },
      });
      const text = result.isError ? result.error ?? '' : (result.data as Array<{ text?: string }>)[0]?.text ?? '';
      assert.deepEqual(probe.calls.map((call) => [call.name, call.resultMaxChars]), [['look', limit], ['peek', limit]],
        'a utility the script runs carries the same figure');
      assert.match(text, new RegExp(`It returned: \\[${limit}, ?true, ?false\\]`),
        'a result of exactly that many NUL characters, the most bytes a character can take, reaches the script whole');
    } finally {
      await done();
    }
  });

  it('a result one character past the figure reaches the script as ResultTooLarge, the call having taken effect', async () => {
    const memoryMaxBytes = 8 * 1024 * 1024;
    const { framework, probe, done } = await makeFramework(new MockMembrane(), { enabled: true, memoryMaxBytes });
    try {
      const result = await framework.executeToolCall({
        id: 'script', name: 'code_execution', callerAgentName: 'prime', input: { code: [
          'try { await tools["probe--look"]({ fill: true, over: 1 }); return "reached"; }',
          'catch (e) { return [e.name, /the call took effect/.test(e.message)]; }',
        ].join('\n') },
      });
      const text = result.isError ? result.error ?? '' : (result.data as Array<{ text?: string }>)[0]?.text ?? '';
      assert.equal(probe.calls.length, 1, 'the tool ran');
      assert.match(text, /It returned: \["ResultTooLarge", ?true\]/);
    } finally {
      await done();
    }
  });

  it("past about 1.5 GiB of a script's memory, on Node, the host's longest string bounds the figure", async () => {
    const memoryMaxBytes = 2 * 1024 * 1024 * 1024;
    const { framework, probe, done } = await makeFramework(new MockMembrane(), { enabled: true, memoryMaxBytes });
    try {
      await framework.executeToolCall({ id: 'script', name: 'code_execution', callerAgentName: 'prime', input: { code: 'await tools["probe--look"]({});' } });
      // The answer is a string before it's bytes: six units a character at most, past the envelope.
      const expected = Math.floor((Math.min(Math.floor(memoryMaxBytes / 3), bufferConstants.MAX_STRING_LENGTH) - 80) / 6);
      assert.deepEqual(probe.calls.map((call) => call.resultMaxChars), [expected]);
    } finally {
      await done();
    }
  });

  it("a code_execution return is held to its agent's inline cap, its output's first and last parts kept", async () => {
    const { framework, done } = await makeFramework(new MockMembrane(), { enabled: true, memoryMaxBytes: 64 * 1024 * 1024 });
    try {
      const result = await framework.executeToolCall({
        id: 'script', name: 'code_execution', callerAgentName: 'prime', input: { code: [
          'text("FIRST" + "a".repeat(20000));',
          'text("b".repeat(20000) + "LAST");',
          'return "x".repeat(3000);',
        ].join('\n') },
      });
      const text = result.isError ? result.error ?? '' : (result.data as Array<{ text?: string }>)[0]?.text ?? '';
      // The strategy's bound beneath the residence's cap is the agent's cap.
      assert.ok(text.length <= BOUNDED, `${text.length} characters, against the agent's cap of ${BOUNDED}`);
      assert.ok(text.includes(`It returned: "${'x'.repeat(3000)}"`), 'the value whole');
      assert.match(text, /Its output:\nFIRST/);
      assert.match(text, /characters of output dropped here/);
      assert.match(text, /LAST\n?$/, "the output's tail ends the return");
    } finally {
      await done();
    }
  });

  it("a model's code_execution return is stored whole under its agent's cap, its output's last characters ending it", async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_script', name: 'code_execution', input: { code: 'text("FIRST" + "a".repeat(20000)); text("b".repeat(20000) + "LAST"); return 1;' } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    const { framework, done } = await makeFramework(membrane, { enabled: true, memoryMaxBytes: 64 * 1024 * 1024 });
    try {
      framework.pushEvent({
        type: 'external-message', source: 'test', content: [{ type: 'text', text: 'run it' }], metadata: {}, triggerInference: true,
      } as unknown as ProcessEvent);
      const stored = await until('the stored return', () => storedResults(framework).get('call_script'));
      assert.ok(stored.length <= BOUNDED, `${stored.length} characters stored, against the agent's cap of ${BOUNDED}`);
      assert.doesNotMatch(stored, /\[truncated/, 'the store had nothing to cut');
      assert.match(stored, /Its output:\nFIRST/);
      assert.match(stored, /LAST\n?$/);
    } finally {
      await done();
    }
  });

  it("the puppet stores a code_execution return under the cap its call carried, though the script lowers the agent's cap", async () => {
    const { framework, probe, done } = await makeFramework(new MockMembrane(), { enabled: true, memoryMaxBytes: 64 * 1024 * 1024 });
    try {
      // The script's own call lowers its agent's cap while the puppeted call runs.
      const overrides = (framework as unknown as { toolResultInlineMaxCharsOverride: Map<string, number> }).toolResultInlineMaxCharsOverride;
      const handle = probe.handleToolCall.bind(probe);
      probe.handleToolCall = async (call) => {
        if (call.name === 'look') overrides.set('prime', 1_000);
        return handle(call);
      };
      const { toolUseId } = await framework.puppetToolCall('prime', 'code_execution', {
        code: 'await tools["probe--look"]({}); text("FIRST" + "a".repeat(20000)); text("b".repeat(20000) + "LAST"); return 1;',
      });
      const stored = storedResults(framework).get(toolUseId);
      assert.ok(stored, 'the pair was stored');
      assert.ok(probe.calls.some((call) => call.name === 'look'), "the script's call ran");
      assert.ok(stored.length > 1_000, `${stored.length} characters: the return was cut under the cap its call carried, not the lowered 1,000`);
      assert.doesNotMatch(stored, /\[truncated/, 'the store had nothing to cut');
      assert.match(stored, /LAST\n?$/);
    } finally {
      await done();
    }
  });

  it("an in-process call's own resultMaxChars holds its code_execution return", async () => {
    const { framework, done } = await makeFramework(new MockMembrane(), { enabled: true, memoryMaxBytes: 64 * 1024 * 1024 });
    try {
      const result = await framework.executeToolCall({
        id: 'script', name: 'code_execution', callerAgentName: 'prime', resultMaxChars: 1_500,
        input: { code: 'text("FIRST" + "a".repeat(20000)); text("b".repeat(20000) + "LAST"); return 1;' },
      });
      const text = result.isError ? result.error ?? '' : (result.data as Array<{ text?: string }>)[0]?.text ?? '';
      assert.ok(text.length <= 1_500, `${text.length} characters, against the caller's 1,500`);
      assert.match(text, /LAST\n?$/);
    } finally {
      await done();
    }
  });

  it('a call made in process carries what its caller put on it, and so does a utility it runs', async () => {
    const { framework, probe, done } = await makeFramework();
    try {
      const run = { tool: 'probe--peek', args: {} };
      await openSettings(framework);
      await framework.executeToolCall({ id: 'bare-look', name: 'probe--look', input: {}, callerAgentName: 'prime' });
      await framework.executeToolCall({ id: 'capped-look', name: 'probe--look', input: {}, callerAgentName: 'prime', resultMaxChars: 4321 });
      await framework.executeToolCall({ id: 'bare-utility', name: 'toolsets--act', input: run, callerAgentName: 'prime' });
      await framework.executeToolCall({ id: 'capped-utility', name: 'toolsets--act', input: run, callerAgentName: 'prime', resultMaxChars: 1234 });
      const caps = new Map(probe.calls.map((call) => [call.id, call.resultMaxChars]));
      assert.deepEqual([...caps.entries()], [['bare-look', undefined], ['capped-look', 4321], ['bare-utility', undefined], ['capped-utility', 1234]]);
    } finally {
      await done();
    }
  });

  it('a call for an agent the framework does not hold carries the house default', async () => {
    const { framework, probe, done } = await makeFramework();
    try {
      framework.pushEvent({
        type: 'tool-call',
        callId: 'ghost-call',
        agentName: 'ghost',
        moduleName: 'probe',
        toolName: 'look',
        call: { id: 'ghost-call', name: 'probe--look', input: {} },
      } as unknown as ProcessEvent);
      const call = await until('the ghost call', () => probe.calls.find((c) => c.id === 'ghost-call'));
      assert.equal(call.resultMaxChars, DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS);
    } finally {
      await done();
    }
  });
});

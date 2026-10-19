/**
 * ToolCall.resultMaxChars: how long a call's result may be and still reach its
 * caller whole. A model's call gets the agent's inline cap as the store applies
 * it, so a result that long is stored whole and one a character longer isn't.
 * A call from a running script gets the script's limit, and a call for an agent
 * the framework doesn't hold gets the house default. A call made in process
 * carries what its caller put on it, and a utility run through `utils` carries
 * what its `utils` call did.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EventResponse,
  Module,
  ProcessEvent,
  ScriptToolResult,
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
/** handleScriptToolCall's bound on what a running script receives. */
const SCRIPT_LIMIT = 5_000_000;

class BoundedStrategy extends PassthroughStrategy {
  readonly maxMessageTokens = 1000;
}

/**
 * Records each call. `look` with `over` answers a text `over` characters past
 * the call's resultMaxChars; without it, a short text. `peek` is a utility.
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
    const over = (call.input as { over?: number } | undefined)?.over;
    const text = over === undefined ? 'ok' : 'x'.repeat((call.resultMaxChars ?? 0) + over);
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

async function makeFramework(membrane: MockMembrane = new MockMembrane()): Promise<{
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

describe('ToolCall.resultMaxChars', () => {
  it("a model's call carries the agent's inline cap, under which its result is stored whole", async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_at', name: 'probe--look', input: { over: 0 } },
      { type: 'tool_use', id: 'call_past', name: 'probe--look', input: { over: 1 } },
      { type: 'tool_use', id: 'call_utility', name: 'utils', input: { action: 'run', name: 'probe--peek', args: {} } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    const { framework, probe, done } = await makeFramework(membrane);
    try {
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
      // This framework has no workspace to spill to, so the store keeps the start.
      assert.equal(stored.get('call_past'),
        `${'x'.repeat(BOUNDED)}\n\n[truncated — original was ${BOUNDED + 1} chars; no writable workspace, full content not retained]`,
        'one character more is cut at the cap');
      // A utility run through the utils tool is stored as that call's result.
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
      const utility = await framework.puppetToolCall('prime', 'utils', { action: 'run', name: 'probe--peek', args: {} });
      const peek = probe.calls.find((call) => call.id === utility.toolUseId);
      assert.equal(peek?.name, 'peek');
      assert.equal(peek?.resultMaxChars, BOUNDED, 'the utility is stored under the cap the puppet stores the pair under');
    } finally {
      await done();
    }
  });

  it("a call from a running script carries the script's limit, under which the script gets its result whole", async () => {
    const { framework, probe, done } = await makeFramework();
    try {
      const script = framework as unknown as {
        handleScriptToolCall(agentName: string, toolName: string, args: Record<string, unknown>): Promise<ScriptToolResult>;
      };
      const at = await script.handleScriptToolCall('prime', 'probe--look', { over: 0 });
      const past = await script.handleScriptToolCall('prime', 'probe--look', { over: 1 });
      await script.handleScriptToolCall('prime', 'utils', { action: 'run', name: 'probe--peek', args: {} });
      assert.deepEqual(probe.calls.map((call) => [call.name, call.resultMaxChars]),
        [['look', SCRIPT_LIMIT], ['look', SCRIPT_LIMIT], ['peek', SCRIPT_LIMIT]], 'a utility the script runs carries its limit too');
      // The text a script's await returns (#538 gives it with isError beside it).
      assert.deepEqual([at.text, at.isError], ['x'.repeat(SCRIPT_LIMIT), false], 'a result of resultMaxChars reaches the script whole');
      assert.equal(past.text, `${'x'.repeat(SCRIPT_LIMIT)}\n\n[truncated — original was ${SCRIPT_LIMIT + 1} chars]`, 'one character more is cut at the limit');
    } finally {
      await done();
    }
  });

  it('a call made in process carries what its caller put on it, and so does a utility it runs', async () => {
    const { framework, probe, done } = await makeFramework();
    try {
      const run = { action: 'run', name: 'probe--peek', args: {} };
      await framework.executeToolCall({ id: 'bare-look', name: 'probe--look', input: {}, callerAgentName: 'prime' });
      await framework.executeToolCall({ id: 'capped-look', name: 'probe--look', input: {}, callerAgentName: 'prime', resultMaxChars: 4321 });
      await framework.executeToolCall({ id: 'bare-utility', name: 'utils', input: run, callerAgentName: 'prime' });
      await framework.executeToolCall({ id: 'capped-utility', name: 'utils', input: run, callerAgentName: 'prime', resultMaxChars: 1234 });
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

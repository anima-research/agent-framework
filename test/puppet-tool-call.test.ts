import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';

/**
 * Framework.puppetToolCall — admin puppet: execute one tool AS an agent and
 * persist the tool_use + tool_result pair byte-shaped like a model-initiated
 * call. Born from the princess exemplar surgery (2026-08-23).
 */

type Stored = { participant: string; content: Array<Record<string, unknown>> };

function puppetHarness(opts?: {
  status?: string;
  surface?: string[];
  result?: { success: boolean; data?: unknown; error?: string; isError?: boolean };
}) {
  const stored: Stored[] = [];
  const traces: Array<Record<string, unknown>> = [];
  const executed: Array<Record<string, unknown>> = [];
  const status = opts?.status ?? 'idle';
  const surface = opts?.surface ?? ['mcpl--eido--look'];
  // Real MCPL results are MCP content arrays — the helper renders them plain.
  const result = opts?.result ?? {
    success: true,
    data: [{ type: 'text', text: 'You are "p" in world "w".' }],
    isError: false,
  };

  const agent = {
    name: 'princess',
    state: { status },
    canUseTool: (name: string) => surface.includes(name),
    getContextManager: () => ({
      addMessage: (participant: string, content: Array<Record<string, unknown>>) => {
        stored.push({ participant, content });
        return `msg-${stored.length}`;
      },
    }),
  };

  const framework = Object.create(AgentFramework.prototype) as AgentFramework;
  (framework as unknown as { agents: Map<string, unknown> }).agents =
    new Map([['princess', agent]]);
  (framework as unknown as { toolImageLedgers: Map<string, unknown> }).toolImageLedgers = new Map();
  (framework as unknown as Record<string, unknown>).getToolsForAgent =
    () => surface.map((name) => ({ name }));
  (framework as unknown as Record<string, unknown>).executeToolCall =
    async (call: Record<string, unknown>) => {
      executed.push(call);
      return result;
    };
  (framework as unknown as Record<string, unknown>).resolveToolResultInlineCap =
    () => ({ cap: undefined });
  (framework as unknown as Record<string, unknown>).emitTrace =
    (e: Record<string, unknown>) => { traces.push(e); };

  return { framework, stored, traces, executed };
}

test('puppetToolCall executes with agent provenance and stores the pair', async () => {
  const { framework, stored, traces, executed } = puppetHarness();
  const quiet = console.log;
  console.log = () => {};
  try {
    const { toolUseId, result } = await framework.puppetToolCall(
      'princess', 'mcpl--eido--look', {},
    );

    assert.match(toolUseId, /^toolu_01[A-Za-z0-9]{22}$/, 'anthropic-shaped id');
    assert.equal(result.success, true);
    assert.equal(executed.length, 1);
    assert.equal(executed[0].callerAgentName, 'princess', 'executes AS the agent');
    assert.equal(executed[0].id, toolUseId, 'wire call carries the stored id');

    assert.equal(stored.length, 2, 'exactly the pair, nothing else');
    const [use, res] = stored;
    assert.equal(use.participant, 'princess', 'tool_use is the agent turn');
    assert.equal(use.content.length, 1, 'bare tool_use — no fabricated text/thinking');
    assert.equal(use.content[0].type, 'tool_use');
    assert.equal(use.content[0].id, toolUseId);
    assert.equal(res.participant, 'user', 'tool_result rides a user message');
    assert.equal(res.content[0].type, 'tool_result');
    assert.equal(res.content[0].toolUseId, toolUseId, 'result pairs with the call');
    assert.equal(res.content[0].toolName, 'mcpl--eido--look');
    assert.equal(res.content[0].isError, false);
    assert.match(String(res.content[0].content), /You are "p"/, 'real result text stored');

    assert.equal(traces.length, 1);
    assert.equal(traces[0].type, 'puppet:tool-call');
    assert.equal(traces[0].agentName, 'princess');
  } finally {
    console.log = quiet;
  }
});

test('puppetToolCall refuses a non-idle agent', async () => {
  const { framework, stored } = puppetHarness({ status: 'streaming' });
  await assert.rejects(
    () => framework.puppetToolCall('princess', 'mcpl--eido--look', {}),
    /requires idle/,
  );
  assert.equal(stored.length, 0, 'nothing stored on refusal');
});

test('puppetToolCall refuses a tool off the agent surface', async () => {
  const { framework, stored, executed } = puppetHarness();
  await assert.rejects(
    () => framework.puppetToolCall('princess', 'mcpl--other--nuke', {}),
    /not on princess's surface/,
  );
  assert.equal(executed.length, 0, 'never executed');
  assert.equal(stored.length, 0, 'nothing stored');
});

test('puppetToolCall refuses an unknown agent', async () => {
  const { framework } = puppetHarness();
  await assert.rejects(
    () => framework.puppetToolCall('ghost', 'mcpl--eido--look', {}),
    /Unknown agent/,
  );
});

test('puppetToolCall stores an error result as isError, still paired', async () => {
  const { framework, stored } = puppetHarness({
    result: { success: false, error: 'MCPL server unreachable', isError: true },
  });
  const quiet = console.log;
  console.log = () => {};
  try {
    const { result } = await framework.puppetToolCall('princess', 'mcpl--eido--look', {});
    assert.equal(result.isError, true);
    assert.equal(stored.length, 2, 'error results are stored too — same as a real turn');
    assert.equal(stored[1].content[0].isError, true);
    assert.match(String(stored[1].content[0].content), /unreachable/);
  } finally {
    console.log = quiet;
  }
});

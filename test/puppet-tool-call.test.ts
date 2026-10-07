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
  // Turn-alive machinery the puppet reserves through (#145).
  const fw = framework as unknown as Record<string, unknown>;
  fw.activeTurnTokens = new Map<string, number>();
  fw.nextTurnToken = 1;
  fw.deferredMessages = [];
  // Flushed-but-unsynced deferred writes (durable-queue ack bookkeeping);
  // a prototype-built harness must seed it like the constructor does.
  fw.unackedDeferredWrites = [];
  fw.deferredSeq = 0;
  fw.deferredScanFrom = new Map();
  fw.pendingAssistantBlocks = new Map();
  fw.primaryAgentName = 'princess';
  // Cross-turn writer path (what a channel message goes through): defers
  // while a turn is alive, else stores — the real guard, reduced.
  fw.addMessage = (participant: string, content: Array<Record<string, unknown>>, _m?: unknown, opts?: { forAgent?: string }) => {
    if ((fw.activeTurnTokens as Map<string, number>).has('princess')) {
      (fw.deferredMessages as unknown[]).push({ participant, content, forAgent: opts?.forAgent });
      return '';
    }
    stored.push({ participant, content });
    return `msg-${stored.length}`;
  };
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

  const turn = fw as unknown as {
    activeTurnTokens: Map<string, number>;
    deferredMessages: Array<{ participant: string; content: Array<Record<string, unknown>>; forAgent?: string }>;
    nextTurnToken: number;
  };
  return { framework, stored, traces, executed, fw: turn };
}

/** A harness whose executeToolCall stays open until `release()` is called. */
function heldHarness() {
  const h = puppetHarness();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const executed: Array<Record<string, unknown>> = [];
  (h.framework as unknown as Record<string, unknown>).executeToolCall =
    async (call: Record<string, unknown>) => {
      executed.push(call);
      await gate;
      return { success: true, data: [{ type: 'text', text: 'done' }], isError: false };
    };
  return { ...h, executed, release };
}

test('puppetToolCall executes with agent provenance and stores the pair', async () => {
  const { framework, stored, traces, executed } = puppetHarness();
  const quiet = console.log;
  console.log = () => {};
  try {
    const { toolUseId, result } = await framework.puppetToolCall(
      'princess', 'mcpl--eido--look', {},
    );

    // null only for a change the operator-change gate staged; none here.
    assert.match(toolUseId ?? '', /^toolu_01[A-Za-z0-9]{22}$/, 'anthropic-shaped id');
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

// ---------------------------------------------------------------------------
// #145 — the idle guard is a point in time; the reservation must span the
// awaits, or a wake starts a turn underneath the pair.
// ---------------------------------------------------------------------------

test('puppetToolCall holds the turn-alive marker across tool execution and releases it after the pair is stored', async () => {
  const { framework, stored, fw, release, executed } = heldHarness();
  const quiet = console.log;
  console.log = () => {};
  try {
    assert.equal(fw.activeTurnTokens.has('princess'), false, 'nothing reserved before the call');
    const p = framework.puppetToolCall('princess', 'mcpl--eido--look', {});
    await new Promise((r) => setImmediate(r));
    assert.equal(executed.length, 1, 'tool is executing');
    assert.equal(fw.activeTurnTokens.has('princess'), true,
      'while the tool runs the agent is turn-alive — the scheduler requeues wakes on exactly this');
    release();
    await p;
    assert.equal(fw.activeTurnTokens.has('princess'), false, 'released once the pair is stored');
    assert.equal(stored.length, 2, 'the pair, stored directly');
    assert.equal(stored[0].content[0].type, 'tool_use');
    assert.equal(stored[1].content[0].type, 'tool_result');
  } finally {
    console.log = quiet;
  }
});

test('puppetToolCall releases the reservation when the tool throws', async () => {
  const { framework, fw } = puppetHarness();
  (framework as unknown as Record<string, unknown>).executeToolCall =
    async () => { throw new Error('boom'); };
  await assert.rejects(() => framework.puppetToolCall('princess', 'mcpl--eido--look', {}), /boom/);
  assert.equal(fw.activeTurnTokens.has('princess'), false, 'no leaked token (the idle+turn-alive wedge)');
});

test('puppetToolCall refuses an idle agent whose turn is still alive (teardown pending)', async () => {
  const { framework, stored, fw } = puppetHarness();
  fw.activeTurnTokens.set('princess', 41);
  await assert.rejects(
    () => framework.puppetToolCall('princess', 'mcpl--eido--look', {}),
    /idle\+turn-alive.*requires idle/,
  );
  assert.equal(stored.length, 0);
  assert.equal(fw.activeTurnTokens.get('princess'), 41, 'someone else\'s token untouched');
});

test('a message arriving while the puppet holds the agent lands AFTER the pair, never between', async () => {
  const { framework, stored, fw, release } = heldHarness();
  const quiet = console.log;
  console.log = () => {};
  try {
    const p = framework.puppetToolCall('princess', 'mcpl--eido--look', {});
    await new Promise((r) => setImmediate(r));
    // a channel message for the agent, mid-execution: the cross-turn writer defers
    (framework as unknown as { addMessage: (p: string, c: unknown[]) => unknown })
      .addMessage('user', [{ type: 'text', text: 'hey, you there?' }]);
    assert.equal(stored.length, 0, 'deferred, not stored mid-puppet');
    assert.equal(fw.deferredMessages.length, 1);
    release();
    await p;
    assert.equal(fw.deferredMessages.length, 0, 'flushed at the puppet\'s end, like a turn\'s end');
    assert.deepEqual(stored.map((m) => m.content[0].type), ['tool_use', 'tool_result', 'text'],
      'pair first and adjacent; the deferred message follows');
  } finally {
    console.log = quiet;
  }
});

test('if a turn replaced the reservation mid-flight, the pair is queued as a unit behind it, not written into it', async () => {
  const { framework, stored, traces, fw, release } = heldHarness();
  const quiet = console.log;
  console.log = () => {};
  try {
    const p = framework.puppetToolCall('princess', 'mcpl--eido--look', {});
    await new Promise((r) => setImmediate(r));
    // the provider-admission re-entry: a turn takes the marker without re-testing it
    fw.activeTurnTokens.set('princess', 9999);
    release();
    await p;
    assert.equal(stored.length, 0, 'nothing written under the live turn');
    assert.equal(fw.activeTurnTokens.get('princess'), 9999, 'the turn\'s token is not clobbered');
    assert.deepEqual(fw.deferredMessages.map((m) => [m.forAgent, m.content[0].type]),
      [['princess', 'tool_use'], ['princess', 'tool_result']],
      'both halves queued, adjacent, addressed to the agent');
    assert.equal(traces[0].deferred, true, 'trace says so');
  } finally {
    console.log = quiet;
  }
});

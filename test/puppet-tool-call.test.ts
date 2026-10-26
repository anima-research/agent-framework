import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/framework.js';
import { MockMembrane } from './helpers/mock-membrane.js';

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
  fw.pendingAssistantBlocks = new Map();
  // Window releases a quiesce postponed: none here, as the constructor starts it.
  fw.releasesAfterResume = new Map();
  // A puppet call is an operation stop() waits for.
  fw.operatorOperations = new Set();
  fw.primaryAgentName = 'princess';
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

/**
 * A framework of its own, with one agent, scout, whose puppeted tool stays
 * open until `release()`: where a message is stored and when it enters the
 * window is the presentation index's (#291), which a prototype-built harness
 * doesn't have.
 */
async function realHeld() {
  const dir = mkdtempSync(join(tmpdir(), 'puppet-tool-call-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    modules: [],
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const internals = framework as unknown as {
    executeToolCall: (call: Record<string, unknown>) => Promise<unknown>;
    activeTurnTokens: Map<string, number>;
    addMessage(participant: string, content: Array<{ type: 'text'; text: string }>): string;
    presentAtEndOf(agent: unknown): void;
  };
  internals.executeToolCall = async () => { await gate; return { success: true, data: [{ type: 'text', text: 'done' }], isError: false }; };
  const cm = framework.getAgent('scout')!.getContextManager();
  const kinds = (rows: Array<{ content: Array<{ type: string; text?: string }> }>) =>
    rows.map((m) => (m.content[0]?.type === 'text' ? m.content[0].text! : m.content[0]?.type));
  return {
    framework, internals, cm, release,
    record: () => kinds(cm.getAllMessages() as never),
    window: () => kinds(cm.getPresentedMessages() as never),
    close: async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// Ported for #291 to a framework of its own: the message is stored at once,
// out of the window, and the puppet's end presents it after the pair. This
// test once ran on the prototype-built harness, whose stand-in addMessage
// queued the message in the deferral queue for the puppet's end to flush.
test('a message arriving while the puppet holds the agent enters the window AFTER the pair, never between', async () => {
  const h = await realHeld();
  const quiet = console.log;
  console.log = () => {};
  try {
    const p = h.framework.puppetToolCall('scout', 'agent_settings', { action: 'get' });
    await new Promise((r) => setImmediate(r));
    // a channel message for the agent, mid-execution
    assert.notEqual(h.internals.addMessage('user', [{ type: 'text', text: 'hey, you there?' }]), '', 'stored at once');
    assert.ok(h.record().includes('hey, you there?'));
    assert.ok(!h.window().includes('hey, you there?'), 'out of the window mid-puppet');
    h.release();
    await p;
    assert.deepEqual(h.window().slice(-3), ['tool_use', 'tool_result', 'hey, you there?'],
      'the pair first and adjacent; the message follows');
  } finally {
    console.log = quiet;
    await h.close();
  }
});

// Ported for #291 as the test above: the pair is stored at once, out of the
// window of the turn that replaced the reservation, and enters it at that
// turn's end. This test once had the pair queued as a unit in the deferral
// queue behind that turn.
test('if a turn replaced the reservation mid-flight, the pair is stored out of its window, adjacent, and enters it at that turn\'s end', async () => {
  const h = await realHeld();
  const quiet = console.log;
  console.log = () => {};
  try {
    const p = h.framework.puppetToolCall('scout', 'agent_settings', { action: 'get' });
    await new Promise((r) => setImmediate(r));
    // the provider-admission re-entry: a turn takes the marker without re-testing it
    h.internals.activeTurnTokens.set('scout', 9999);
    h.release();
    await p;
    assert.equal(h.internals.activeTurnTokens.get('scout'), 9999, 'the turn\'s token is not clobbered');
    assert.deepEqual(h.record().slice(-2), ['tool_use', 'tool_result'], 'both halves stored, adjacent');
    assert.ok(!h.window().includes('tool_use') && !h.window().includes('tool_result'), 'out of the live turn\'s window');
    h.internals.activeTurnTokens.delete('scout');
    h.internals.presentAtEndOf(h.framework.getAgent('scout'));
    assert.deepEqual(h.window().slice(-2), ['tool_use', 'tool_result'], "in the window at that turn's end, adjacent");
  } finally {
    console.log = quiet;
    await h.close();
  }
});

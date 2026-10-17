/**
 * A refusal is an error result. tune_out's refusals, channel_open on a
 * tuned-out channel, the subconscious's refusals and the api module's
 * "Unknown tool" reach the model flagged as errors, with the refusal's text,
 * so it can tell a refusal from a success. Before, only deliver_summary's
 * "subconscious not configured" was flagged: the model read each of the
 * others as a tool that ran and answered (in XML tool mode, as the tool's
 * stdout), and channel_open's refusal showed it only its data, never the
 * sentence that says how to cancel the tune-out. A script's call gets each
 * refusal as "Error: <text>", and a module calling in process gets the
 * result flagged, with the tuned-out refusal's data kept.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework, ApiModule } from '../src/index.js';
import type { Module, ModuleContext, ToolDefinition, ToolResult } from '../src/index.js';
import { TUNE_OUT_DEFAULTS } from '../src/tune-out/coordinator.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';
const TUNED_OUT = `Channel ${CHANNEL} is tuned out. Cancel the tune-out (tune_out with mode: 'cancel') ` +
  'to resume normal attention — cancelling delivers the diverted backlog.';

type SentResult = { toolUseId: string; content: unknown; isError: boolean };

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A module that keeps its context, to call tools in process as a module does. */
class ContextKeeper implements Module {
  readonly name = 'context-keeper';
  ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }
  async stop(): Promise<void> {
    this.ctx = null;
  }
  getTools(): ToolDefinition[] {
    return [];
  }
  async handleToolCall(): Promise<ToolResult> {
    return { success: false, error: 'no tools', isError: true };
  }
  async onProcess(): Promise<Record<string, never>> {
    return {};
  }
}

/** A resident and its subconscious, with the fixture's one channel registered. */
async function setUp(t: TestContext, allowChannelSpeech = false, modules: Module[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'refusals-are-errors-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
    subconscious: { enabled: true, systemPrompt: 'Watch tuned-out channels and report.', allowChannelSpeech },
    mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE] }],
    modules: [new ApiModule(), ...modules],
  });
  t.after(async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const registry = (framework as unknown as {
    channelRegistry: { listChannelsRaw(): unknown[] } | null;
  }).channelRegistry;
  await waitFor(() => (registry?.listChannelsRaw().length ?? 0) > 0, 'channel registration');
  return { framework, membrane };
}

/**
 * Runs one turn of `agent` that makes each round of calls in turn, and
 * returns, for each round, the results sent back to the model by call id.
 */
async function runRounds(
  framework: AgentFramework,
  membrane: MockMembrane,
  agent: string,
  rounds: Array<Array<{ id: string; name: string; input: Record<string, unknown> }>>,
): Promise<Array<Map<string, { content: unknown; isError: boolean }>>> {
  for (const calls of rounds) {
    membrane.pushResponse(createMockResponse(calls.map((c) => ({ type: 'tool_use' as const, ...c })), 'tool_use'));
  }
  membrane.pushResponse(createMockResponse([]));
  assert.equal(framework.nudgeAgent(agent).ok, true);
  await framework.runUntilIdle();
  const sent = (membrane.lastStream!.receivedToolResults as SentResult[][]).map(
    (round) => new Map(round.map((r) => [r.toolUseId, { content: r.content, isError: r.isError }])),
  );
  assert.equal(sent.length, rounds.length, `${agent} answered every round`);
  return sent;
}

test("the resident's refusals reach the model as error results, and a tune-out it enters as a success", async (t) => {
  const { framework, membrane } = await setUp(t);
  const [first, second, third] = await runRounds(framework, membrane, 'scout', [
    [
      { id: 'unknown', name: 'tune_out', input: { channelId: 'disc:guild:none' } },
      { id: 'cancel', name: 'tune_out', input: { channelId: CHANNEL, mode: 'cancel' } },
      { id: 'api', name: 'api--lookup', input: {} },
    ],
    [{ id: 'enter', name: 'tune_out', input: { channelId: CHANNEL } }],
    [
      { id: 'again', name: 'tune_out', input: { channelId: CHANNEL } },
      { id: 'open', name: 'channel_open', input: { channelId: CHANNEL } },
    ],
  ]);
  assert.deepEqual(first!.get('unknown'), { content: 'unknown channel: disc:guild:none', isError: true });
  assert.deepEqual(first!.get('cancel'), { content: `channel ${CHANNEL} is not tuned out`, isError: true });
  assert.deepEqual(first!.get('api'), { content: 'Unknown tool', isError: true });
  // A control: the same tool's success still reads as one.
  const { cadenceSeconds, backlogCap, maxWakes } = TUNE_OUT_DEFAULTS;
  assert.deepEqual(second!.get('enter'), {
    content: JSON.stringify({ tunedOut: CHANNEL, cadenceSeconds, backlogCap, maxWakes }),
    isError: false,
  });
  assert.deepEqual(third!.get('again'), {
    content: `channel ${CHANNEL} is already tuned out (cancel first to change params)`,
    isError: true,
  });
  assert.deepEqual(third!.get('open'), { content: TUNED_OUT, isError: true });
});

test("the subconscious's refusals reach it as error results", async (t) => {
  const { framework, membrane } = await setUp(t);
  const [round] = await runRounds(framework, membrane, 'Subconscious', [[
    { id: 'summary', name: 'deliver_summary', input: { text: '  ', channelId: CHANNEL } },
    { id: 'cancel', name: 'cancel_tuneout', input: { channelId: CHANNEL } },
    { id: 'note', name: 'note_disposition', input: { key: '', text: 'ignore release-bot' } },
    { id: 'speak', name: 'speak_in_channel', input: { channelId: CHANNEL, text: 'They are tuned out.' } },
  ]]);
  assert.deepEqual(round!.get('summary'), { content: 'empty summary', isError: true });
  assert.deepEqual(round!.get('cancel'), { content: `channel ${CHANNEL} is not tuned out`, isError: true });
  assert.deepEqual(round!.get('note'), { content: 'key required', isError: true });
  assert.deepEqual(round!.get('speak'), {
    content: 'channel speech is disabled for the subconscious (recipe: subconscious.allowChannelSpeech)',
    isError: true,
  });
});

test("the subconscious's speak_in_channel with no text, where channel speech is allowed, reaches it as an error result", async (t) => {
  const { framework, membrane } = await setUp(t, true);
  const [round] = await runRounds(framework, membrane, 'Subconscious', [[
    { id: 'speak', name: 'speak_in_channel', input: { channelId: CHANNEL, text: '   ' } },
  ]]);
  assert.deepEqual(round!.get('speak'), { content: 'empty message', isError: true });
});

test('a script, and a module calling in process, get the refusals as errors too', async (t) => {
  const keeper = new ContextKeeper();
  const { framework } = await setUp(t, false, [keeper]);
  // A script's call is answered through the event loop, so it has to run.
  framework.start();
  const script = (tool: string, input: Record<string, unknown>) => (framework as unknown as {
    handleScriptToolCall(agent: string, tool: string, args: Record<string, unknown>): Promise<string>;
  }).handleScriptToolCall('scout', tool, input);
  assert.equal(await script('tune_out', { channelId: 'disc:guild:none' }), 'Error: unknown channel: disc:guild:none');
  assert.equal(await script('api--lookup', {}), 'Error: Unknown tool');
  // A control: the same tool's success still reads as one.
  const { cadenceSeconds, backlogCap, maxWakes } = TUNE_OUT_DEFAULTS;
  assert.equal(
    await script('tune_out', { channelId: CHANNEL }),
    JSON.stringify({ tunedOut: CHANNEL, cadenceSeconds, backlogCap, maxWakes }),
  );
  assert.equal(await script('channel_open', { channelId: CHANNEL }), `Error: ${TUNED_OUT}`);
  // A module gets the result as the registry returns it: flagged, with the
  // refusal's data kept, so it can still read why.
  assert.deepEqual(await keeper.ctx!.callTool({ id: 'ctx-open', name: 'channel_open', input: { channelId: CHANNEL } }), {
    success: false,
    isError: true,
    error: TUNED_OUT,
    data: { refusal: 'tuned-out', channelId: CHANNEL },
  });
  assert.deepEqual(
    await keeper.ctx!.callTool({ id: 'ctx-api', name: 'api--lookup', input: {} }),
    { success: false, error: 'Unknown tool', isError: true },
  );
});

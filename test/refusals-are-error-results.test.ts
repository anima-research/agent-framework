/**
 * A refusal is an error result. tune_out's refusals, channel_open on a
 * tuned-out channel, the subconscious's refusals and the api module's
 * unknown-tool answer reach the model flagged as errors, with the refusal's text,
 * so it can tell a refusal from a success. Before, only deliver_summary's
 * "subconscious not configured" was flagged: the model read each of the
 * others as a tool that ran and answered (in XML tool mode, as the tool's
 * stdout), and channel_open's refusal showed it only its data, never the
 * sentence that says how to cancel the tune-out. A script's call gets each
 * tool's refusal as a result with isError and the refusal's text, and a call
 * the dispatcher refused before it opened as an Error (ToolResult.refused); a module
 * calling in process gets the result flagged, with the tuned-out refusal's
 * data kept.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework, ApiModule } from '../src/index.js';
import type { Module, ModuleContext, ToolDefinition, ToolResult } from '../src/index.js';
import { scriptCall } from './helpers/script-call.js';
import { TUNE_OUT_DEFAULTS } from '../src/tune-out/coordinator.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';
/** The api module's answer for a tool it doesn't have: it has none. */
const API_UNKNOWN = 'There\'s no tool "api--lookup", so nothing ran. The api module has no tools of its own: every tool you can call is in your tool list.';
const TUNED_OUT = `Channel "${CHANNEL}" is tuned out: its messages go to the subconscious, and channel_open doesn't change ` +
  `that. Call tune_out with channelId "${CHANNEL}" and mode "cancel" for it to resume normal attention; cancelling ` +
  'delivers the diverted backlog.';

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
  assert.deepEqual(first!.get('cancel'), {
    content: 'Nothing was cancelled: no connected channel is tuned out now. A tune-out also ends by itself when its '
      + 'duration runs out, or at the first wake past its wake budget, and its backlog goes to you then.',
    isError: true,
  });
  assert.deepEqual(first!.get('api'), { content: API_UNKNOWN, isError: true });
  // A control: the same tool's success still reads as one.
  const { cadenceSeconds, backlogCap, maxWakes } = TUNE_OUT_DEFAULTS;
  assert.deepEqual(second!.get('enter'), {
    content: JSON.stringify({ tunedOut: CHANNEL, cadenceSeconds, backlogCap, maxWakes }),
    isError: false,
  });
  assert.deepEqual(third!.get('again'), {
    content: `Nothing changed: "${CHANNEL}" is already tuned out, with cadenceSeconds ${cadenceSeconds}, backlogCap `
      + `${backlogCap} and maxWakes ${maxWakes}. To change those, cancel it first with tune_out mode "cancel", which `
      + 'delivers its backlog to you now, then call tune_out again with the new settings.',
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
  assert.deepEqual(round!.get('summary'), {
    content: 'Nothing was delivered: deliver_summary needs the summary in "text". If there\'s nothing to report, '
      + "don't call it: staying silent is allowed.",
    isError: true,
  });
  assert.deepEqual(round!.get('cancel'), {
    content: 'Nothing was cancelled: no connected channel is tuned out now. A tune-out also ends by itself when its '
      + 'duration runs out, or at the first wake past its wake budget, and its backlog goes to the resident then.',
    isError: true,
  });
  assert.deepEqual(round!.get('note'), {
    content: 'Nothing was recorded: note_disposition needs a "key", a short stable name for the note, such as '
      + '"busy-channels". To delete a note, call it with that note\'s key and an empty "text".',
    isError: true,
  });
  assert.deepEqual(round!.get('speak'), {
    content: "Nothing was posted: speak_in_channel is turned off for you in the resident's configuration, and calling "
      + "it again won't change that. The resident can speak there: tell it what's needed with deliver_summary, or, if the "
      + 'channel is tuned out and needs the resident now, end the tune-out with cancel_tuneout.',
    isError: true,
  });
});

test("the subconscious's speak_in_channel with no text, where channel speech is allowed, reaches it as an error result", async (t) => {
  const { framework, membrane } = await setUp(t, true);
  const [round] = await runRounds(framework, membrane, 'Subconscious', [[
    { id: 'speak', name: 'speak_in_channel', input: { channelId: CHANNEL, text: '   ' } },
  ]]);
  assert.deepEqual(round!.get('speak'), {
    content: 'Nothing was posted: speak_in_channel needs the message in "text".',
    isError: true,
  });
});

test('a script, and a module calling in process, get the refusals as errors too', async (t) => {
  const keeper = new ContextKeeper();
  const { framework } = await setUp(t, false, [keeper]);
  // A script's call is answered through the event loop, so it has to run.
  framework.start();
  const script = (tool: string, input: Record<string, unknown>) => scriptCall(framework, 'scout', tool, input);
  const failed = (text: string) => ({ refused: false, content: [{ type: 'text', text }], structuredContent: null, isError: true });
  // A tool's own refusal reaches the script as a result flagged as an error.
  assert.deepEqual(await script('tune_out', { channelId: 'disc:guild:none' }), failed('unknown channel: disc:guild:none'));
  // A module's answer for a tool it doesn't have comes once the call has opened:
  // a failure whose text says nothing ran, not a refusal.
  assert.deepEqual(await script('api--lookup', {}), failed(API_UNKNOWN));
  // A control: the same tool's success still reads as one.
  const { cadenceSeconds, backlogCap, maxWakes } = TUNE_OUT_DEFAULTS;
  assert.deepEqual(
    await script('tune_out', { channelId: CHANNEL }),
    { refused: false, content: [{ type: 'text', text: JSON.stringify({ tunedOut: CHANNEL, cadenceSeconds, backlogCap, maxWakes }) }], structuredContent: null, isError: false },
  );
  assert.deepEqual(await script('channel_open', { channelId: CHANNEL }), failed(TUNED_OUT));
  // A script can't start a script: refused before any dispatch.
  assert.deepEqual(
    await script('code_execution', { code: 'return 1;' }),
    { refused: true, name: 'ToolRefused', message: 'code_execution cannot be called from within a script; nothing was done', tool: 'code_execution' },
  );
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
    { success: false, error: API_UNKNOWN, isError: true },
  );
});

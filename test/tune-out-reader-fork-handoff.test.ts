/**
 * The framework's side of handing a reader fork what is queued behind the
 * resident's turn, on a real framework with a real deferred queue: a
 * resident whose turn waits on a tool, a tuned-out channel on the MCPL
 * fixture, and addressed messages that wake the reader.
 *
 * Only the fork itself is stubbed (`deriveAgent`, `runEphemeralToCompletion`),
 * so this runs without the Dendrite builds of chronicle and context-manager.
 * It checks what the stub is given: the framing's backlog and
 * `heldMessageIds`, which name each queued message by the held handle of its
 * deferred write; the `tune-out:reader-fork` counts; that a landed row
 * carries the same write id as `metadata.deferredWriteId`, so nothing is
 * handed twice; and that a fork whose derive fails gives its messages back
 * to the next reader (`tune-out:reader-fork-failed`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { heldHandle } from '../src/held-writes.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';

/** A tool the resident's turn waits on until the test lets it go. */
class WaitModule implements Module {
  readonly name = 'probe';
  hold: Promise<void> = Promise.resolve();
  onWait: () => void = () => {};
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'wait', description: 'Wait for the test', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    this.onWait();
    await this.hold;
    return { success: true, data: { ok: true } };
  }
  async onProcess(event: { type: string; source?: string }): Promise<EventResponse> {
    if (event.type !== 'external-message' || event.source !== 'probe') return {};
    return { addMessages: [{ participant: 'Antra', content: [{ type: 'text', text: 'go' }] }], requestInference: true };
  }
}

class ResidentMembrane {
  private queue: NormalizedResponse[] = [];
  push(...responses: NormalizedResponse[]): void { this.queue.push(...responses); }
  streamYielding(_request: NormalizedRequest): MockYieldingStream {
    const responses = this.queue.splice(0);
    if (responses.length === 0) responses.push(createMockResponse([{ type: 'text', text: 'ok' }]));
    return new MockYieldingStream(responses);
  }
  asMembrane(): import('@animalabs/membrane').Membrane { return this as unknown as import('@animalabs/membrane').Membrane; }
}

const textOf = (content: Array<{ type: string; text?: string }>): string =>
  content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

async function waitFor(what: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface DeriveCall { name: string; framing: Array<{ content: ContentBlock[]; metadata: { heldMessageIds?: string[] } }> }

describe('reader forks: the framework hands on what is queued behind the resident turn', () => {
  it('names queued messages by their write handles, gives a failed fork\'s messages to the next reader, and hands nothing twice once they land', { timeout: 120_000 }, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tune-out-reader-handoff-'));
    const commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    const membrane = new ResidentMembrane();
    const module = new WaitModule();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: { enabled: true, reader: 'forks', model: 'test-model', voice: 'Read for scout.' },
      mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath } }],
      modules: [module],
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));
    const derives: DeriveCall[] = [];
    let failNextDerive = false;
    const stubbed = framework as unknown as {
      deriveAgent: (options: DeriveCall) => Promise<unknown>;
      runEphemeralToCompletion: () => Promise<{ speech: string }>;
      tuneOutCoordinator: TuneOutCoordinator;
      deferredMessages: Array<{ id: string; content: ContentBlock[] }>;
      channelRegistry: { listChannelsRaw(): unknown[] };
    };
    stubbed.deriveAgent = async (options) => {
      derives.push(options);
      if (failNextDerive) {
        failNextDerive = false;
        throw new Error('derive failed (test)');
      }
      return { agent: { name: options.name }, contextManager: {} };
    };
    stubbed.runEphemeralToCompletion = async () => ({ speech: '' });
    const orig = console.error;
    console.error = () => {};
    let release: () => void = () => {};
    try {
      await framework.start();
      await waitFor('channel registration', () => stubbed.channelRegistry.listChannelsRaw().length > 0);
      assert.ok(stubbed.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 200, maxWakes: 5 }, 'agent-tool').ok);
      const forks = () => traces.filter((t) => t.type === 'tune-out:reader-fork') as Array<TraceEvent & { held: number; queued: number }>;
      const failures = () => traces.filter((t) => t.type === 'tune-out:reader-fork-failed') as Array<TraceEvent & { returned: number; reported: boolean }>;
      const queuedIdOf = (needle: string) => stubbed.deferredMessages.find((m) => textOf(m.content).includes(needle))?.id;
      const say = (kind: 'ambient' | 'addressed', id: string, text: string) => appendFileSync(commandPath, `${kind} ${id} ${text}\n`);

      // The resident's turn waits on a tool, so what arrives is queued.
      let waiting!: () => void;
      const inTool = new Promise<void>((resolve) => { waiting = resolve; });
      module.hold = new Promise<void>((resolve) => { release = resolve; });
      module.onWait = waiting;
      membrane.push(
        createMockResponse([{ type: 'text', text: 'Waiting.' }, { type: 'tool_use', id: 'w1', name: 'probe--wait', input: {} }] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: 'Done.' }]),
      );
      framework.pushEvent({ type: 'external-message', source: 'probe', content: 'go' } as never);
      await inTool;

      say('ambient', 'a1', 'AMB-1 chatter');
      say('ambient', 'a2', 'AMB-2 more chatter');
      say('addressed', 'x3', 'ADDR-3 hey scout, your build is stuck');
      await waitFor('the first fork', () => forks().length === 1);
      const ids = ['AMB-1', 'AMB-2', 'ADDR-3'].map((s) => queuedIdOf(s));
      assert.ok(ids.every((id) => typeof id === 'string'), 'all three are still queued');
      assert.equal(forks()[0]!.held, 3);
      assert.equal(forks()[0]!.queued, 3, 'the trace counts them as queued');
      const framing = derives[0]!.framing[0]!;
      assert.deepEqual(framing.metadata.heldMessageIds, ids.map((id) => heldHandle(id!)), "each is named by its deferred write's held handle");
      const shown = textOf(framing.content as never);
      for (const s of ['AMB-1 chatter', 'AMB-2 more chatter', 'ADDR-3 hey scout']) assert.ok(shown.includes(s), `the framing shows ${s}`);
      assert.ok(shown.includes("arrived while scout's turn was running"), shown);

      // A fork whose derive fails gives its message back.
      failNextDerive = true;
      say('addressed', 'x4', 'ADDR-4 are you there');
      await waitFor('the failed fork', () => failures().length === 1);
      assert.equal(failures()[0]!.returned, 1, 'ADDR-4 goes back to the backlog');
      assert.equal(failures()[0]!.reported, false);
      say('addressed', 'x5', 'ADDR-5 hello?');
      await waitFor('the next fork', () => forks().length === 2);
      assert.equal(forks()[1]!.held, 2, 'it is handed ADDR-4 again, and ADDR-5');
      const second = textOf(derives[2]!.framing[0]!.content as never);
      assert.ok(second.includes('ADDR-4 are you there') && second.includes('ADDR-5 hello?'), second);
      assert.ok(!second.includes('AMB-1'), 'and nothing the first fork was handed');

      // The turn ends: the queued writes land under their write ids.
      release();
      await waitFor('the queue drains', () => stubbed.deferredMessages.length === 0);
      await framework.runUntilIdle();
      const stored = framework.getAgent('scout')!.getContextManager().getAllMessages() as unknown as Array<{ content: ContentBlock[]; metadata?: { deferredWriteId?: string } }>;
      for (const [i, s] of ['AMB-1', 'AMB-2', 'ADDR-3'].entries()) {
        const row = stored.find((m) => textOf(m.content as never).includes(s));
        assert.equal(row?.metadata?.deferredWriteId, ids[i], `${s} landed carrying its write id`);
      }

      // So the next reader, with the resident idle, is handed only what is new.
      say('addressed', 'x6', 'ADDR-6 one more');
      await waitFor('the last fork', () => forks().length === 3);
      assert.equal(forks()[2]!.held, 1);
      assert.equal(forks()[2]!.queued, 0, 'ADDR-6 was stored directly');
      const last = textOf(derives[3]!.framing[0]!.content as never);
      assert.ok(last.includes('ADDR-6 one more'), last);
      for (const s of ['AMB-1', 'AMB-2', 'ADDR-3', 'ADDR-4', 'ADDR-5']) assert.ok(!last.includes(s), `and not ${s}, now stored`);
    } finally {
      release();
      console.error = orig;
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a fork still running when its tune-out ends, which then fails, gets one late fork through the framework, and a late fork that fails gets none', { timeout: 120_000 }, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tune-out-reader-late-'));
    const commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new ResidentMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: { enabled: true, reader: 'forks', model: 'test-model', voice: 'Read for scout.' },
      mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath } }],
      modules: [],
    });
    const derives: DeriveCall[] = [];
    // The first fork's derive waits for the test, then fails, as a fork still
    // running at the cancel would; every later one fails at once. Past ten,
    // derives succeed, so a chain of late forks ends and the test can say so.
    let letFirstFail: () => void = () => {};
    const firstFails = new Promise<void>((resolve) => { letFirstFail = resolve; });
    const stubbed = framework as unknown as {
      deriveAgent: (options: DeriveCall) => Promise<unknown>;
      runEphemeralToCompletion: () => Promise<{ speech: string }>;
      tuneOutCoordinator: TuneOutCoordinator;
      channelRegistry: { listChannelsRaw(): unknown[] };
    };
    stubbed.deriveAgent = async (options) => {
      derives.push(options);
      if (derives.length === 1) await firstFails;
      if (derives.length > 10) return { agent: { name: options.name }, contextManager: {} };
      throw new Error('derive failed (test)');
    };
    stubbed.runEphemeralToCompletion = async () => ({ speech: '' });
    const orig = console.error;
    console.error = () => {};
    try {
      await framework.start();
      await waitFor('channel registration', () => stubbed.channelRegistry.listChannelsRaw().length > 0);
      assert.ok(stubbed.tuneOutCoordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 200, maxWakes: 5 }, 'agent-tool').ok);
      appendFileSync(commandPath, 'addressed x1 ADDR-1 are you there\n');
      await waitFor('the first fork is deriving', () => derives.length === 1);
      assert.ok(stubbed.tuneOutCoordinator.cancel('disc', CHANNEL, 'agent-tool', 'test').ok, 'the tune-out ends while that fork runs');
      await waitFor("the cancel's own last fork", () => derives.length === 2);
      assert.ok(!textOf(derives[1]!.framing[0]!.content as never).includes('ADDR-1'), "premise: the cancel's last fork isn't handed ADDR-1");
      letFirstFail();
      await waitFor('the late fork', () => derives.length >= 3);
      const late = textOf(derives[2]!.framing[0]!.content as never);
      assert.ok(late.includes('ADDR-1 are you there'), late);
      assert.ok(late.includes('handed to a reader that failed after the tune-out ended'), late);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(derives.length, 3, 'the late fork failed too, and no other fork was derived');
    } finally {
      letFirstFail();
      console.error = orig;
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * One reader-fork rig per test file (as the e2e has it): a resident on a
 * fixture MCPL server, a membrane that routes responses by role, the
 * tune-out entered by hand. A second rig in the same process never comes up, so the speech
 * on/off cases live in two files.
 */
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../../src/index.js';
import type { TraceEvent } from '../../src/index.js';
import type { Module } from '../../src/types/index.js';
import { MockYieldingStream, createMockResponse } from './mock-membrane.js';
import type { TuneOutCoordinator } from '../../src/tune-out/coordinator.js';
import { jsonLines } from './json-lines.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures/tune-out-mcpl-server.mjs');
export const CHANNEL = 'disc:guild:noisy';
const SECTION = { model: 'test-model', voice: 'You are reading for scout. Report in second person, briefly.' };

const DEBUG = process.env.READER_RIG_DEBUG === '1';
const debug = (...args: unknown[]) => { if (DEBUG) console.error('[rig]', ...args); };
if (DEBUG) setInterval(() => debug('tick', new Date().toISOString().slice(11, 19)), 3000).unref();

class RoutedMembrane {
  calls: NormalizedRequest[] = [];
  private queues = { resident: [] as NormalizedResponse[], reader: [] as NormalizedResponse[] };
  push(who: 'resident' | 'reader', ...responses: NormalizedResponse[]): void { this.queues[who].push(...responses); }
  /** One stream takes every response queued for its role: a tool round and its continuation go in together. */
  streamYielding(request: NormalizedRequest): MockYieldingStream {
    this.calls.push(request);
    const who = JSON.stringify(request.messages).includes('[Tune-out reader') ? 'reader' : 'resident';
    const responses = this.queues[who].splice(0);
    debug('request', who, 'messages', request.messages.length, 'responses', responses.length, 'toolCalls', responses.map((r) => r.toolCalls.length));
    return new MockYieldingStream(responses);
  }
  asMembrane(): import('@animalabs/membrane').Membrane { return this as unknown as import('@animalabs/membrane').Membrane; }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  debug('waiting:', what);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (cond()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`timed out waiting for: ${what}`);
}

type Internals = {
  tuneOutCoordinator: TuneOutCoordinator | null;
  channelRegistry: { listChannelsRaw(): unknown[] } | null;
};
const internals = (f: AgentFramework) => f as unknown as Internals;
export const toolNames = (request: NormalizedRequest) => ((request as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name);

export function rig(name: string, allowChannelSpeech: boolean, opts: { modules?: Module[] } = {}) {
  const traces: TraceEvent[] = [];
  const state = { tempDir: '', commandPath: '', statusPath: '', membrane: new RoutedMembrane(), framework: null as AgentFramework | null, traces };
  before(async () => {
    state.tempDir = mkdtempSync(join(tmpdir(), `tune-out-${name}-`));
    state.commandPath = join(state.tempDir, 'commands.txt');
    state.statusPath = join(state.tempDir, 'status.jsonl');
    writeFileSync(state.commandPath, '');
    writeFileSync(state.statusPath, '');
    state.framework = await AgentFramework.create({
      storePath: join(state.tempDir, 'test.chronicle'),
      membrane: state.membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: { enabled: true, reader: 'forks', ...SECTION, allowChannelSpeech },
      mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: state.statusPath, COMMAND_PATH: state.commandPath } }],
      modules: opts.modules ?? [],
    });
    state.framework.onTrace((event) => {
      traces.push(event);
      if (/^(dendrite|tune-out|tool|mcpl:speech)/.test(event.type)) debug('trace', event.type, JSON.stringify(event).slice(0, 200));
    });
    await state.framework.start();
    await waitFor(() => (internals(state.framework!).channelRegistry?.listChannelsRaw().length ?? 0) > 0, 'channel registration');
  });
  after(async () => {
    debug('after: stopping');
    // A failed case can leave a fork mid-run with nothing queued for it; a stop that waits on it would hang the file.
    await Promise.race([state.framework?.stop(), new Promise((r) => setTimeout(r, 10_000))]);
    debug('after: stopped');
    rmSync(state.tempDir, { recursive: true, force: true });
  });
  const published = () => jsonLines<{ event: string; channelId?: string }>(state.statusPath).filter((e) => e.event === 'publish');
  return {
    state,
    waitFor,
    emit: (kind: 'ambient' | 'addressed', id: string, text: string): void => { appendFileSync(state.commandPath, `${kind} ${id} ${text}\n`); },
    forkTraces: () => traces.filter((t) => t.type === 'tune-out:reader-fork') as Array<TraceEvent & { agentName: string }>,
    refusals: () => traces.filter((t) => t.type === 'tool:failed' && (t as { module: string }).module === 'dendrite') as Array<TraceEvent & { tool: string; error: string }>,
    published,
    /** Wake scout once and tune the channel out, so the next addressed message derives a reader fork. */
    tuneOut: async () => {
      state.membrane.push('resident', createMockResponse([{ type: 'text', text: 'hi' }]));
      appendFileSync(state.commandPath, 'addressed m0 scout, are you around?\n');
      await waitFor(() => state.membrane.calls.length >= 1, 'scout wakes');
      await state.framework!.runUntilIdle();
      const entered = internals(state.framework!).tuneOutCoordinator!.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 2, maxWakes: 1 }, 'agent-tool');
      assert.ok(entered.ok);
      // Scout's own turn posted its "hi": what the fork adds is counted from here.
      return published().length;
    },
  };
}

export const publishCall = (id: string) => createMockResponse([{ type: 'tool_use', id, name: 'channel_publish', input: { channelId: CHANNEL, text: 'the fork, posting' } }], 'tool_use');
export const speakCall = (id: string) => createMockResponse([{ type: 'tool_use', id, name: 'speak_in_channel', input: { channelId: CHANNEL, text: 'the fork, speaking' } }], 'tool_use');


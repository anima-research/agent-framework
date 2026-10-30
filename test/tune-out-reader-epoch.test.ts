import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const CHANNEL = 'disc:guild:noisy';
const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const options = { cadenceSeconds: 3600, backlogCap: 2, maxWakes: 2 };

class EpochMembrane {
  calls: NormalizedRequest[] = [];
  streams = new Map<string, MockYieldingStream>();
  onOldRequest: (() => void) | undefined;
  private queues = new Map<string, NormalizedResponse[]>();

  push(name: string, ...responses: NormalizedResponse[]): void {
    const queue = this.queues.get(name) ?? [];
    queue.push(...responses);
    this.queues.set(name, queue);
  }

  streamYielding(request: NormalizedRequest): MockYieldingStream {
    this.calls.push(request);
    const name = request.assistantParticipant ?? 'scout';
    if (name === 'reader-old' && this.onOldRequest) {
      const transition = this.onOldRequest;
      this.onOldRequest = undefined;
      transition();
    }
    const responses = this.queues.get(name)?.splice(0) ?? [];
    if (responses.length === 0) responses.push(createMockResponse([{ type: 'text', text: 'ack' }]));
    const stream = new MockYieldingStream(responses);
    this.streams.set(name, stream);
    return stream;
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

type Fixture = {
  framework: AgentFramework;
  coordinator: TuneOutCoordinator;
  membrane: EpochMembrane;
  statusPath: string;
};

async function waitFor(ready: () => boolean, name: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for ' + name);
}

async function withFixture(allowChannelSpeech: boolean, check: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'reader-epoch-'));
  const statusPath = join(dir, 'status.jsonl');
  const commandPath = join(dir, 'commands.txt');
  writeFileSync(statusPath, '');
  writeFileSync(commandPath, '');
  const membrane = new EpochMembrane();
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: {
        enabled: true, reader: 'forks', model: 'test-model',
        voice: 'Read the held channel.', allowChannelSpeech,
      },
      mcplServers: [{
        id: 'disc', command: process.execPath, args: [FIXTURE],
        env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    await framework.start();
    const internals = framework as unknown as {
      tuneOutCoordinator: TuneOutCoordinator | null;
      channelRegistry: { listChannelsRaw(): unknown[] } | null;
    };
    await waitFor(() => (internals.channelRegistry?.listChannelsRaw().length ?? 0) > 0, 'channel registration');
    assert.ok(internals.tuneOutCoordinator, 'premise: a reader coordinator is active');
    await check({ framework, coordinator: internals.tuneOutCoordinator, membrane, statusPath });
  } finally {
    try {
      if (framework) await framework.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const hold = (coordinator: TuneOutCoordinator): string => {
  const entered = coordinator.enter('disc', CHANNEL, options, 'test');
  assert.equal(entered.ok, true, 'premise: this channel accepts a new hold');
  return entered.params.epochId;
};

async function readerCall(
  h: Fixture,
  name: string,
  epoch: string | undefined,
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): Promise<Array<{ toolUseId: string; content: string; isError?: boolean }>> {
  const fork = await h.framework.deriveAgent({
    name, from: 'scout', mode: 'copy', kind: 'subconscious-fork',
    ...(epoch ? { metadata: { epochId: epoch, channelId: CHANNEL, trigger: 'wake' } } : {}),
    resultTo: { to: 'scout', as: 'message' },
    framing: [{ participant: 'user', content: [{ type: 'text', text: 'Read and report.' }] }],
  });
  h.membrane.push(name,
    createMockResponse(calls.map((call) => ({ type: 'tool_use', ...call })) as never, 'tool_use'),
    createMockResponse([{ type: 'text', text: 'Done' }]));
  await h.framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
  assert.ok(h.membrane.calls.some((request) => request.assistantParticipant === name),
    'premise: the registered reader made a model request');
  const stream = h.membrane.streams.get(name);
  assert.ok(stream, 'premise: the reader completed its stream');
  return stream.receivedToolResults.flat() as Array<{ toolUseId: string; content: string; isError?: boolean }>;
}

function oldToNew(h: Fixture, oldEpoch: string): () => string {
  let nextEpoch: string | undefined;
  h.membrane.onOldRequest = () => {
    assert.equal(h.framework.getAgentRecord('reader-old')?.metadata?.epochId, oldEpoch,
      'premise: the live reader carries its originating epoch');
    assert.equal(h.coordinator.holdFor('disc', CHANNEL)?.epochId, oldEpoch,
      'premise: the original hold is current before transition');
    assert.equal(h.coordinator.cancel('disc', CHANNEL, 'test', 'the first epoch ended').ok, true);
    nextEpoch = hold(h.coordinator);
    assert.notEqual(nextEpoch, oldEpoch, 'premise: a later hold has a different epoch');
  };
  return () => {
    assert.ok(nextEpoch, 'premise: the old reader remained live through a later hold');
    return nextEpoch;
  };
}

const outcome = (
  results: Array<{ toolUseId: string; content: string; isError?: boolean }>,
  id: string,
) => {
  const result = results.find((entry) => entry.toolUseId === id);
  assert.ok(result, 'premise: ' + id + ' received a result');
  return result;
};

const publishes = (statusPath: string): number =>
  readFileSync(statusPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string })
    .filter((entry) => entry.event === 'publish').length;

const residentReceived = (h: Fixture, name: string): boolean =>
  h.framework.getAgent('scout')!.getContextManager().getAllMessages()
    .some((message) => message.participant === name
      && (message.metadata as { kind?: string } | undefined)?.kind === 'agent-result');

test('an old reader cannot cancel a newer hold on the same channel, but the new reader can', async () => {
  await withFixture(false, async (h) => {
    const first = hold(h.coordinator);
    const next = oldToNew(h, first);
    const old = await readerCall(h, 'reader-old', first, [
      { id: 'old-cancel', name: 'cancel_tuneout', input: { channelId: CHANNEL } },
    ]);
    const second = next();
    assert.equal(h.coordinator.holdFor('disc', CHANNEL)?.epochId, second,
      'the earlier reader must leave the newer hold intact');
    assert.equal(outcome(old, 'old-cancel').isError, true);
    assert.match(outcome(old, 'old-cancel').content, /hold you were (?:started to read|reading for)/);

    const current = await readerCall(h, 'reader-current', second, [
      { id: 'current-cancel', name: 'cancel_tuneout', input: { channelId: CHANNEL } },
    ]);
    assert.notEqual(outcome(current, 'current-cancel').isError, true,
      'the current reader may cancel its own hold');
    assert.equal(h.coordinator.holdFor('disc', CHANNEL), null);
  });
});

test('an old reader cannot post into a later hold, but its current reader can when speech is on', async () => {
  await withFixture(true, async (h) => {
    const first = hold(h.coordinator);
    const next = oldToNew(h, first);
    const old = await readerCall(h, 'reader-old', first, [
      { id: 'old-speak', name: 'speak_in_channel', input: { channelId: CHANNEL, text: 'old epoch reply' } },
    ]);
    const second = next();
    assert.equal(h.coordinator.holdFor('disc', CHANNEL)?.epochId, second);
    assert.equal(publishes(h.statusPath), 0, 'the old reader did not post under the resident account');
    assert.equal(outcome(old, 'old-speak').isError, true);

    const current = await readerCall(h, 'reader-current', second, [
      { id: 'current-speak', name: 'speak_in_channel', input: { channelId: CHANNEL, text: 'current epoch reply' } },
    ]);
    assert.notEqual(outcome(current, 'current-speak').isError, true);
    assert.equal(publishes(h.statusPath), 1, 'the current reader posted once');
    assert.equal(h.coordinator.holdFor('disc', CHANNEL)?.epochId, second);
  });
});

test('speech disabled for the current reader never posts', async () => {
  await withFixture(false, async (h) => {
    const epoch = hold(h.coordinator);
    const results = await readerCall(h, 'reader-current', epoch, [
      { id: 'off-speak', name: 'speak_in_channel', input: { channelId: CHANNEL, text: 'should not post' } },
    ]);
    assert.equal(outcome(results, 'off-speak').isError, true);
    assert.equal(publishes(h.statusPath), 0);
    assert.equal(h.coordinator.holdFor('disc', CHANNEL)?.epochId, epoch);
  });
});

test('a reader without an originating epoch cannot cancel a current hold but may report', async () => {
  await withFixture(false, async (h) => {
    const epoch = hold(h.coordinator);
    const results = await readerCall(h, 'reader-unbound', undefined, [
      { id: 'unbound-cancel', name: 'cancel_tuneout', input: { channelId: CHANNEL } },
      { id: 'unbound-report', name: 'deliver_summary', input: { channelId: CHANNEL, text: 'This hold needs your attention.' } },
    ]);
    assert.equal(h.framework.getAgentRecord('reader-unbound')?.kind, 'subconscious-fork');
    assert.equal(h.framework.getAgentRecord('reader-unbound')?.metadata?.epochId, undefined);
    assert.equal(h.coordinator.holdFor('disc', CHANNEL)?.epochId, epoch);
    assert.equal(outcome(results, 'unbound-cancel').isError, true);
    assert.match(outcome(results, 'unbound-cancel').content, /weren't started to read a tune-out/);
    assert.notEqual(outcome(results, 'unbound-report').isError, true);
    await waitFor(() => residentReceived(h, 'reader-unbound'), 'the report reaches the resident');
  });
});

test('a reader without an originating epoch cannot speak into a current hold but may report', async () => {
  await withFixture(true, async (h) => {
    const epoch = hold(h.coordinator);
    const results = await readerCall(h, 'reader-unbound', undefined, [
      { id: 'unbound-speak', name: 'speak_in_channel', input: { channelId: CHANNEL, text: 'should not post' } },
      { id: 'unbound-report', name: 'deliver_summary', input: { channelId: CHANNEL, text: 'This hold needs your attention.' } },
    ]);
    assert.equal(h.framework.getAgentRecord('reader-unbound')?.kind, 'subconscious-fork');
    assert.equal(h.framework.getAgentRecord('reader-unbound')?.metadata?.epochId, undefined);
    assert.equal(publishes(h.statusPath), 0);
    assert.equal(h.coordinator.holdFor('disc', CHANNEL)?.epochId, epoch);
    assert.equal(outcome(results, 'unbound-speak').isError, true);
    assert.match(outcome(results, 'unbound-speak').content, /weren't started to read a tune-out/);
    assert.notEqual(outcome(results, 'unbound-report').isError, true);
    await waitFor(() => residentReceived(h, 'reader-unbound'), 'the report reaches the resident');
  });
});

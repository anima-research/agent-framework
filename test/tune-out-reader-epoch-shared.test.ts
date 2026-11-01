import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const CHANNEL = 'disc:guild:noisy';
const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');

class RoutedMembrane {
  calls: NormalizedRequest[] = [];
  readerStreams: MockYieldingStream[] = [];
  onFirstReader: (() => void) | undefined;
  private readerResponses: NormalizedResponse[] = [];

  pushReader(...responses: NormalizedResponse[]): void { this.readerResponses.push(...responses); }

  streamYielding(request: NormalizedRequest): MockYieldingStream {
    this.calls.push(request);
    const reader = JSON.stringify(request.messages).includes('[Tune-out reader');
    if (reader && this.onFirstReader) {
      const transition = this.onFirstReader;
      this.onFirstReader = undefined;
      transition();
    }
    const responses = reader ? this.readerResponses.splice(0) : [];
    if (responses.length === 0) responses.push(createMockResponse([{ type: 'text', text: 'ack' }]));
    const stream = new MockYieldingStream(responses);
    if (reader) this.readerStreams.push(stream);
    return stream;
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

async function waitFor(ready: () => boolean, name: string): Promise<void> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for ' + name);
}

const resultOf = (stream: MockYieldingStream, id: string) => {
  const results = stream.receivedToolResults.flat() as Array<{ toolUseId: string; content: string; isError?: boolean }>;
  const result = results.find((entry) => entry.toolUseId === id);
  assert.ok(result, 'premise: ' + id + ' received a result');
  return result;
};

test('a real reader fork carries its epoch and leaves a later hold and channel untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reader-epoch-shared-'));
  const commandPath = join(dir, 'commands.txt');
  const statusPath = join(dir, 'status.jsonl');
  writeFileSync(commandPath, '');
  writeFileSync(statusPath, '');
  const membrane = new RoutedMembrane();
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: {
        enabled: true, reader: 'forks', model: 'test-model',
        voice: 'Read the held channel.', allowChannelSpeech: true,
      },
      mcplServers: [{
        id: 'disc', command: process.execPath, args: [FIXTURE],
        env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    const active = framework;
    const internal = active as unknown as {
      tuneOutCoordinator: TuneOutCoordinator | null;
      channelRegistry: { listChannelsRaw(): unknown[] } | null;
    };
    const readers: Array<{ name: string; epoch: string; trigger: string }> = [];
    active.onTrace((event) => {
      if (event.type !== 'tune-out:reader-fork') return;
      readers.push({
        name: event.agentName as string,
        epoch: event.epochId as string,
        trigger: event.trigger as string,
      });
    });
    await active.start();
    await waitFor(() => (internal.channelRegistry?.listChannelsRaw().length ?? 0) > 0, 'local channel registration');
    const coordinator = internal.tuneOutCoordinator;
    assert.ok(coordinator, 'premise: the local channel has a reader coordinator');
    const first = coordinator.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 2, maxWakes: 2 }, 'test');
    assert.equal(first.ok, true, 'premise: the first hold began');
    const firstEpoch = first.params.epochId;
    let secondEpoch: string | undefined;
    membrane.onFirstReader = () => {
      const old = readers.find((reader) => reader.epoch === firstEpoch && reader.trigger === 'wake');
      assert.ok(old, 'premise: the first hold created a live reader');
      assert.equal(active.getAgentRecord(old.name)?.metadata?.epochId, firstEpoch,
        'the actual reader inherited the first hold epoch');
      assert.equal(coordinator.holdFor('disc', CHANNEL)?.epochId, firstEpoch);
      assert.equal(coordinator.cancel('disc', CHANNEL, 'test', 'first hold ended').ok, true);
      const second = coordinator.enter('disc', CHANNEL,
        { cadenceSeconds: 3600, backlogCap: 2, maxWakes: 2 }, 'test');
      assert.equal(second.ok, true, 'premise: a later hold began');
      secondEpoch = second.params.epochId;
      assert.notEqual(secondEpoch, firstEpoch);
    };
    membrane.pushReader(
      createMockResponse([
        { type: 'tool_use', id: 'old-cancel', name: 'cancel_tuneout', input: { channelId: CHANNEL } },
        { type: 'tool_use', id: 'old-speak', name: 'speak_in_channel',
          input: { channelId: CHANNEL, text: 'old reader reply' } },
      ] as never, 'tool_use'),
      createMockResponse([{ type: 'text', text: 'Done' }]));
    appendFileSync(commandPath, 'addressed m1 read this held message\n');
    await waitFor(() => membrane.readerStreams.length > 0 && secondEpoch !== undefined, 'old reader request and new hold');
    const old = readers.find((reader) => reader.epoch === firstEpoch && reader.trigger === 'wake');
    assert.ok(old);
    await waitFor(() => active.getAgentRecord(old.name)?.ended !== undefined, 'old reader completed');
    assert.equal(coordinator.holdFor('disc', CHANNEL)?.epochId, secondEpoch,
      'the old reader did not cancel the later hold');
    const firstStream = membrane.readerStreams[0]!;
    assert.equal(resultOf(firstStream, 'old-cancel').isError, true);
    assert.equal(resultOf(firstStream, 'old-speak').isError, true);
    const posts = readFileSync(statusPath, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string })
      .filter((entry) => entry.event === 'publish');
    assert.equal(posts.length, 0, 'the old reader did not post to the current channel');
  } finally {
    try {
      if (framework) await framework.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

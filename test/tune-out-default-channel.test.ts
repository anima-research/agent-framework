import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import type { HeartbeatWake } from '../src/heartbeat/heartbeat.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const OTHER = 'disc:guild:other';
const NOISY = 'disc:guild:noisy';
const TICK: HeartbeatWake = { kind: 'heartbeat', reason: 'manual', silent: false, text: '[heartbeat] Periodic self-check-in.', eventId: 'hb-1' };

type Internals = {
  tuneOutCoordinator: TuneOutCoordinator | null;
  channelRegistry: {
    listChannelsRaw(): unknown[];
    buildChannelContext(agentName: string, serverId: string): { incoming?: { channelId: string; messageId: string } } | undefined;
    getDefaultPublishChannel(): { serverId: string; channelId: string } | null;
  } | null;
  deliverHeartbeat(wake: HeartbeatWake): void;
};

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const textOf = (m: { content: Array<{ type: string; text?: string }> }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

async function withResident(run: (r: {
  internals: Internals;
  emit(line: string): void;
  turn(text: string, start: () => void, onSecond?: boolean): Promise<string[]>;
  publishTurn(start: () => void, onSecond?: boolean): Promise<string[]>;
  emitSecond(line: string): void;
  removeSecond(): Promise<void>;
  skipReplyTurn(start: () => void): Promise<void>;
  tuneOut(channelId: string): void;
  cancelNoisy(): void;
  divertOnNoisy(id: string): Promise<void>;
  incoming(): string | undefined;
  publishedOnSecond(): string[];
}) => Promise<void>, options: { secondServer?: boolean; gate?: boolean } = {}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tune-out-default-channel-'));
  const statusPath = join(dir, 'status.jsonl');
  const commandPath = join(dir, 'commands.txt');
  const secondStatusPath = join(dir, 'status-2.jsonl');
  writeFileSync(commandPath, '');
  writeFileSync(join(dir, 'commands-2.txt'), '');
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' },
    heartbeat: { statePath: join(dir, 'heartbeat.json'), defaults: { paused: true } },
    mcplServers: [
      { id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath, CHANNELS: 'other,noisy' } },
      ...(options.secondServer ? [{
        id: 'disc2', command: process.execPath, args: [FIXTURE],
        env: { STATUS_PATH: secondStatusPath, COMMAND_PATH: join(dir, 'commands-2.txt'), CHANNELS: 'other,noisy' },
      }] : []),
    ],
    ...(options.gate ? { gate: { config: { policies: [], default: 'always' as const } } } : {}),
    modules: [],
  });
  const internals = framework as unknown as Internals;
  const publishedIn = (path: string): string[] => !existsSync(path) ? [] : readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { event: string; channelId?: string })
    .filter((e) => e.event === 'publish').map((e) => e.channelId ?? '');
  const publishes = (): string[] => publishedIn(statusPath);
  const idle = (): boolean => framework.getHostModeStatus().activeTurnAgents.length === 0;
  const rows = () => framework.getAgent('scout')!.getContextManager().getAllMessages();
  const emit = (line: string): void => appendFileSync(commandPath, `${line}\n`);
  const turn = async (text: string, start: () => void, onSecond = false): Promise<string[]> => {
    const publishes = (): string[] => publishedIn(onSecond ? secondStatusPath : statusPath);
    const from = publishes().length;
    const calls = membrane.calls.length;
    membrane.pushResponse(createMockResponse([{ type: 'text', text }]));
    start();
    await waitFor(() => membrane.calls.length > calls, `the turn answered "${text}"`);
    await waitFor(() => idle() && publishes().length > from, `"${text}" published`);
    return publishes().slice(from);
  };
  const publishTurn = async (start: () => void, onSecond = false): Promise<string[]> => {
    const publishes = (): string[] => publishedIn(onSecond ? secondStatusPath : statusPath);
    const from = publishes().length;
    const calls = membrane.calls.length;
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'p1', name: 'channel_publish', input: { content: 'Checking in.' } }], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    start();
    await waitFor(() => membrane.calls.length > calls, 'the turn called channel_publish');
    await waitFor(() => idle() && publishes().length > from, 'its channel_publish posted');
    return publishes().slice(from);
  };
  const skipReplyTurn = async (start: () => void): Promise<void> => {
    const calls = membrane.calls.length;
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 's1', name: 'skip_reply', input: { reason: 'back shortly', wake_in_seconds: 1 } }], 'tool_use'));
    start();
    await waitFor(() => membrane.calls.length > calls && idle(), 'the turn skipped its reply');
  };
  try {
    await framework.start();
    const channels = options.secondServer ? 4 : 2;
    await waitFor(() => (internals.channelRegistry?.listChannelsRaw().length ?? 0) >= channels, 'every channel registered');
    assert.deepEqual(await turn('Hi antra.', () => emit('addressed@other E1 hello scout')), [OTHER]);
    await run({
      internals,
      emit,
      turn,
      publishTurn,
      emitSecond: (line) => appendFileSync(join(dir, 'commands-2.txt'), `${line}\n`),
      removeSecond: () => framework.disconnectMcplServer('disc2'),
      skipReplyTurn,
      tuneOut: (channelId) => assert.ok(internals.tuneOutCoordinator!.enter('disc', channelId, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool').ok),
      cancelNoisy: () => assert.ok(internals.tuneOutCoordinator!.cancel('disc', NOISY, 'subconscious', 'test').ok),
      incoming: () => internals.channelRegistry!.buildChannelContext('scout', 'disc')?.incoming?.messageId,
      publishedOnSecond: () => publishedIn(secondStatusPath),
      divertOnNoisy: async (id) => {
        emit(`ambient@noisy ${id} chatter in the tuned-out channel ${id}`);
        await waitFor(() => rows().some((m) => textOf(m).includes(`channel ${id}`)), `${id} stored`);
        const row = rows().find((m) => textOf(m).includes(`channel ${id}`))!;
        assert.ok(row.metadata?.tuneOut, `${id} is diverted`);
      },
    });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a tune-out and where the resident speaks', () => {
  it('after a message the tune-out diverted, the message the resident is replying to is still the one before it, and channel_publish with no channelId posts in its channel', async () => {
    await withResident(async (r) => {
      r.tuneOut(NOISY);
      await r.divertOnNoisy('D1');
      assert.equal(r.incoming(), 'E1');
      assert.deepEqual(await r.publishTurn(() => r.internals.deliverHeartbeat(TICK)), [OTHER]);
    });
  });

  it('after a message the tune-out diverted, a turn with no channel of its own speaks where the resident last heard a message', async () => {
    await withResident(async (r) => {
      r.tuneOut(NOISY);
      await r.divertOnNoisy('D1');
      await r.skipReplyTurn(() => r.internals.deliverHeartbeat(TICK));
      assert.deepEqual(await r.turn('Back again.', () => {}), [OTHER]);
    }, { gate: true });
  });

  it('with every channel that has spoken tuned out, there is no default channel and no message the resident is replying to', async () => {
    await withResident(async (r) => {
      r.tuneOut(NOISY);
      await r.divertOnNoisy('D1');
      r.tuneOut(OTHER);
      assert.equal(r.internals.channelRegistry!.getDefaultPublishChannel(), null);
      assert.equal(r.incoming(), undefined);
      const registry = r.internals.channelRegistry as unknown as {
        handleChannelToolCall(tool: string, input: object, origin: object): Promise<{ success: boolean; error?: string }>;
      };
      const refused = await registry.handleChannelToolCall('channel_publish', { content: 'Anyone?' }, { kind: 'agent', agentName: 'scout', own: [] });
      assert.equal(refused.success, false);
      assert.match(refused.error ?? '', /^Nothing was posted: channel_publish needs a `channelId`, and there's no channel to default to yet\./);
    });
  });

  it('after the resident tunes out the channel it last heard a message on, channel_publish with no channelId posts where it heard a message before that, and that channel counts again once the tune-out ends', async () => {
    await withResident(async (r) => {
      assert.deepEqual(await r.turn('Hello noisy.', () => r.emit('ambient@noisy N0 busy in here')), [NOISY]);
      assert.equal(r.incoming(), 'N0');
      r.tuneOut(NOISY);
      assert.equal(r.incoming(), 'E1');
      assert.deepEqual(await r.publishTurn(() => r.internals.deliverHeartbeat(TICK)), [OTHER]);
      await r.turn('About the backlog.', () => r.cancelNoisy());
      assert.equal(r.incoming(), 'N0', 'the message before the tune-out counts again once it ends');
    });
  });

  it('once a tune-out ends, its channel\'s latest message, the diverted one included, is where channel_publish with no channelId posts', async () => {
    await withResident(async (r) => {
      r.tuneOut(NOISY);
      await r.divertOnNoisy('D1');
      await r.turn('About the backlog.', () => r.cancelNoisy());
      assert.equal(r.incoming(), 'D1');
      assert.deepEqual(await r.publishTurn(() => r.internals.deliverHeartbeat(TICK)), [NOISY]);
    });
  });

  it('the resident\'s wake when a tune-out ends speaks in the channel it ended on its own server, when another server has a channel with its id', async () => {
    await withResident(async (r) => {
      r.tuneOut(NOISY);
      assert.deepEqual(await r.turn('About the backlog.', () => r.cancelNoisy()), [NOISY]);
      assert.deepEqual(r.publishedOnSecond(), []);
    }, { secondServer: true });
  });

  it('when a tune-out ends after its channel\'s server was removed, the resident\'s wake for it speaks where a turn with no channel of its own does', async () => {
    await withResident(async (r) => {
      assert.ok(r.internals.tuneOutCoordinator!.enter('disc2', NOISY, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool').ok);
      await r.removeSecond();
      const cancel = () => assert.ok(r.internals.tuneOutCoordinator!.cancel('disc2', NOISY, 'subconscious', 'test').ok);
      assert.deepEqual(await r.turn('About the backlog.', cancel), [OTHER]);
    }, { secondServer: true });
  });

  it('past a newer message on a tuned-out channel, the default is the latest message on a channel that isn\'t tuned out, on another server when it came in there', async () => {
    await withResident(async (r) => {
      assert.deepEqual(await r.turn('Hello from the second server.', () => r.emitSecond('addressed@other E2 hello scout'), true), [OTHER]);
      r.tuneOut(NOISY);
      await r.divertOnNoisy('D1');
      assert.deepEqual(r.internals.channelRegistry!.getDefaultPublishChannel(), { serverId: 'disc2', channelId: OTHER });
      assert.deepEqual(await r.publishTurn(() => r.internals.deliverHeartbeat(TICK), true), [OTHER]);
    }, { secondServer: true });
  });

  for (const diverted of [false, true]) {
    it(`the resident's wake when a tune-out ends speaks in the channel it ended (${diverted ? 'after a diverted message' : 'nothing diverted'})`, async () => {
      await withResident(async (r) => {
        r.tuneOut(NOISY);
        if (diverted) await r.divertOnNoisy('D1');
        assert.deepEqual(await r.turn('About the backlog.', () => r.cancelNoisy()), [NOISY]);
      });
    });
  }
});

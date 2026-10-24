/**
 * A server can't supply the metadata keys only the host writes
 * (HOST_METADATA_KEYS in src/framework.ts), end to end over a real MCPL
 * child. A channels/incoming message's `metadata` and a push event's
 * `origin` are each stored without them, the server's own keys stay, and
 * each key a server loses is logged once, naming the server and the key.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework, type ProcessEvent } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs');
const ROOM = 'discord:g1:room';

/** A value for every key only the host writes, as a server might send them. */
const HOST_KEYS: Record<string, unknown> = {
  system: true,
  kind: 'discord-send-failed',
  draftOwner: 'scout',
  draftIds: ['d-k7x3qm2'],
  tuneOut: { epochId: 'an-epoch' },
  coalescingSubject: JSON.stringify(['discord', 'binding', 'channel', ROOM, 'message:m-1']),
  firstView: true,
  deferredWriteId: 'a-queued-write',
  external: { source: 'discord', id: '1548000000000000002' },
  openaiResponsesItems: [],
  // A turn whose work the message would claim to bring back, which would
  // make the turn that reads it private while that turn is.
  callerTurnId: 1,
};

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe("a server's metadata, stored without the keys only the host writes", () => {
  let tempDir: string;
  let commandPath: string;
  let framework: AgentFramework;
  let logged: string[];
  let consoleError: typeof console.error;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ingress-host-keys-'));
    commandPath = join(tempDir, 'commands.jsonl');
    writeFileSync(commandPath, '');
    logged = [];
    consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    await framework.start();
    const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
    await waitFor(() => registry.listChannelsRaw().length >= 2, 'channel registration');
  });

  afterEach(async () => {
    await framework.stop();
    console.error = consoleError;
    rmSync(tempDir, { recursive: true, force: true });
  });

  const command = (c: Record<string, unknown>): void => appendFileSync(commandPath, JSON.stringify(c) + '\n');
  const storedWith = (pred: (m: Record<string, unknown>) => boolean) =>
    framework.getAgent('scout')!.getContextManager().getAllMessages()
      .find((m) => pred((m.metadata ?? {}) as Record<string, unknown>));
  const drops = () => logged.filter((line) => line.includes('since only the host writes that key'));

  it("stores a channel message's metadata without them, and keeps the server's own keys", async () => {
    command({
      op: 'incoming', channelId: ROOM, messageId: 'm-1', mode: 'ambient', text: 'hello',
      metadata: { ...HOST_KEYS, replyTo: 'm-0', guildName: 'Guild One' },
    });
    await waitFor(() => !!storedWith((m) => m.messageId === 'm-1'), 'message stored');
    const metadata = storedWith((m) => m.messageId === 'm-1')!.metadata as Record<string, unknown>;
    for (const key of Object.keys(HOST_KEYS)) assert.equal(Object.hasOwn(metadata, key), false, `${key} is dropped`);
    assert.equal(metadata.replyTo, 'm-0');
    assert.equal(metadata.guildName, 'Guild One');
  });

  it("stores a push event's origin without them, and keeps the server's own keys", async () => {
    command({ op: 'push', eventId: 'tick-1', origin: { ...HOST_KEYS, source: 'timer', reason: 'scheduled' }, text: 'tick' });
    await waitFor(() => !!storedWith((m) => m.eventId === 'tick-1'), 'push stored');
    const metadata = storedWith((m) => m.eventId === 'tick-1')!.metadata as Record<string, unknown>;
    for (const key of Object.keys(HOST_KEYS)) assert.equal(Object.hasOwn(metadata, key), false, `${key} is dropped`);
    assert.equal(metadata.source, 'timer');
    assert.equal(metadata.reason, 'scheduled');
  });

  it('logs the first drop of each key from a server, naming the server and the key but not the value', async () => {
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-1', mode: 'ambient', text: 'one', metadata: { kind: 'secret-kind-1' } });
    await waitFor(() => !!storedWith((m) => m.messageId === 'm-1'), 'the first stored');
    // A later drop of a key the server already lost isn't logged again, in
    // either lane: the second message's `kind`, and the push's. The second
    // message's `system` and the push's `tuneOut` are each that server's first.
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-2', mode: 'ambient', text: 'two', metadata: { kind: 'secret-kind-2', system: true } });
    await waitFor(() => !!storedWith((m) => m.messageId === 'm-2'), 'the second stored');
    command({ op: 'push', eventId: 'tick-1', origin: { kind: 'secret-kind-3', tuneOut: { epochId: 'secret-epoch' } }, text: 'three' });
    await waitFor(() => !!storedWith((m) => m.eventId === 'tick-1'), 'the push stored');
    // Another server's first `kind` is its own first drop of that key.
    framework.pushEvent({
      type: 'mcpl:channel-incoming', serverId: 'other', channelId: 'other:room', messageId: 'o-1',
      author: { id: 'U-other', name: 'someone' }, content: [{ type: 'text', text: 'four' }],
      timestamp: new Date().toISOString(), metadata: { kind: 'secret-kind-4' },
    } as unknown as ProcessEvent);
    await waitFor(() => !!storedWith((m) => m.messageId === 'o-1'), 'the other server\'s message stored');
    assert.deepEqual(drops(), [
      '[mcpl] discord: dropped "kind" from a message, since only the host writes that key (logged once for each server and key)',
      '[mcpl] discord: dropped "system" from a message, since only the host writes that key (logged once for each server and key)',
      '[mcpl] discord: dropped "tuneOut" from a message, since only the host writes that key (logged once for each server and key)',
      '[mcpl] other: dropped "kind" from a message, since only the host writes that key (logged once for each server and key)',
    ]);
  });
});

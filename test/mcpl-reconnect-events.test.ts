/**
 * McplServerConnection reconnect lifecycle events.
 *
 * Covers the event contract the framework's wireMcplEvents turns into
 * mcpl:server-* trace events:
 *   - 'connect-failed'   buffered on the disconnected stub until ready()
 *   - 'reconnect-failed' per failed background attempt, with attempt ordinal
 *   - 'reconnect'        on revival, with the attempt count that succeeded
 *   - 'close'            with (code, signal) on unexpected child exit
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';

// The .mjs fixture is not compiled/copied by tsc, so when this test runs from
// dist/test it must reach back into the source tree for it.
const FIXTURE = [
  join(import.meta.dirname, 'fixtures/flaky-mcpl-server.mjs'),
  join(import.meta.dirname, '../../test/fixtures/flaky-mcpl-server.mjs'),
].find((p) => existsSync(p))!;
const TMP_DIR = join(import.meta.dirname, '../.test-tmp-reconnect');
const FLAG_FILE = join(TMP_DIR, 'server-healthy');

const HOST_CAPS: McplHostCapabilities = {
  version: '0.5',
  pushEvents: true,
  contextHooks: { beforeInference: true },
  featureSets: true,
};

function makeConfig(overrides?: Partial<McplServerConfig>): McplServerConfig {
  return {
    id: 'flaky',
    command: process.execPath,
    args: [FIXTURE, FLAG_FILE],
    reconnect: true,
    reconnectIntervalMs: 50,
    ...overrides,
  };
}

/** Poll until `predicate` returns true or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

let connection: McplServerConnection | null = null;

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await connection?.close();
  connection = null;
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('McplServerConnection — reconnect lifecycle events', () => {
  it('buffers connect-failed on the stub, emits reconnect-failed per retry, then reconnect on recovery', async () => {
    // Flag file absent: the initial connect fails and we get a stub.
    connection = await McplServerConnection.connectWithReconnect(makeConfig(), HOST_CAPS);
    assert.strictEqual(connection.capabilities, null);

    const connectFailed: Array<{ error: string; attempt: number }> = [];
    const reconnectFailed: Array<{ error: string; attempt: number }> = [];
    const reconnected: Array<{ attempts: number }> = [];
    connection.on('connect-failed', (p: { error: string; attempt: number }) => connectFailed.push(p));
    connection.on('reconnect-failed', (p: { error: string; attempt: number }) => reconnectFailed.push(p));
    connection.on('reconnect', (p: { attempts: number }) => reconnected.push(p));

    // The initial failure fired before listeners existed — ready() flushes it.
    connection.ready();
    assert.strictEqual(connectFailed.length, 1);
    assert.strictEqual(connectFailed[0]!.attempt, 0);
    assert.match(connectFailed[0]!.error, /before handshake/);

    // At least one background retry fails while the server stays down.
    await waitFor(() => reconnectFailed.length >= 1, 5000, 'first reconnect-failed');
    assert.strictEqual(reconnectFailed[0]!.attempt, 1);

    // Bring the server up; the next attempt succeeds.
    writeFileSync(FLAG_FILE, '');
    await waitFor(() => reconnected.length === 1, 10_000, 'reconnect');
    assert.ok(
      reconnected[0]!.attempts >= 2,
      `reconnect should report the attempt ordinal that succeeded, got ${reconnected[0]!.attempts}`,
    );
    assert.strictEqual(connection.willReconnect, true);
  });

  it('emits close with (code, signal) on unexpected exit, then revives with attempts=1', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);

    const closes: Array<{ code: number | null; signal: string | null }> = [];
    const reconnected: Array<{ attempts: number }> = [];
    connection.on('close', (code?: number | null, signal?: string | null) =>
      closes.push({ code: code ?? null, signal: signal ?? null }));
    connection.on('reconnect', (p: { attempts: number }) => reconnected.push(p));
    connection.ready();

    // The fixture exits(7) when it receives tools/list — a remote-controlled
    // crash. The pending request rejects when the process dies.
    connection.sendToolsList().catch(() => {});

    await waitFor(() => closes.length === 1, 5000, 'close event');
    assert.strictEqual(closes[0]!.code, 7);
    assert.strictEqual(closes[0]!.signal, null);
    assert.strictEqual(connection.willReconnect, true);

    // The server is still healthy (flag file present), so the first retry wins.
    await waitFor(() => reconnected.length === 1, 5000, 'reconnect after crash');
    assert.strictEqual(reconnected[0]!.attempts, 1);
  });

  it('explicit close() disables reconnect and reports willReconnect=false', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    connection.ready();

    const reconnected: unknown[] = [];
    connection.on('reconnect', (p: unknown) => reconnected.push(p));

    assert.strictEqual(connection.willReconnect, true);
    await connection.close();
    assert.strictEqual(connection.willReconnect, false);

    // No revival after an explicit close.
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(reconnected.length, 0);
    connection = null;
  });

  it('clears the previous transport grant before publishing a reconnected handshake', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    connection.establishGrant(new CapabilityGrant(new Set(['pushEvents']), []));
    assert.strictEqual(connection.policyEstablished, true);
    assert.deepStrictEqual(connection.grant.effectiveList(), ['pushEvents']);

    let stateAtReconnect: { policyEstablished: boolean; grant: string[] } | null = null;
    connection.on('reconnect', () => {
      stateAtReconnect = {
        policyEstablished: connection!.policyEstablished,
        grant: connection!.grant.effectiveList(),
      };
    });
    connection.ready();

    // Crash the old transport. The replacement handshake is a fresh policy
    // epoch: no authority from the prior process may survive until the host's
    // new §5.3 Request receives its degradation receipt.
    connection.sendToolsList().catch(() => {});
    await waitFor(() => stateAtReconnect !== null, 5000, 'reconnect after granted transport');

    assert.deepStrictEqual(stateAtReconnect, {
      policyEstablished: false,
      grant: [],
    });
  });

  it('holds a reconnected transport\'s control traffic, not only its data, until the host opens the planes', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    const controlEvents: string[] = [];
    connection.on('tools-list-changed', () => controlEvents.push('tools-list-changed'));
    let reconnected = false;
    connection.on('reconnect', () => { reconnected = true; });
    connection.ready();
    connection.emit('tools-list-changed');
    assert.deepStrictEqual(controlEvents, ['tools-list-changed'], 'an open control plane delivers');

    connection.sendToolsList().catch(() => {});
    await waitFor(() => reconnected, 5000, 'reconnect after crash');
    // What the fresh transport sends is admitted against a grant the host
    // has not re-established yet: it waits, as at initial connect.
    connection.emit('tools-list-changed');
    assert.deepStrictEqual(controlEvents, ['tools-list-changed'], 'control traffic is held after the boundary');
    connection.ready();
    assert.deepStrictEqual(controlEvents, ['tools-list-changed', 'tools-list-changed'], 'and released when the planes open');
  });

  it('holds a reconnected transport\'s data traffic until the host has its grant and opens the planes', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    const pushes: unknown[] = [];
    connection.on('push-event', (params: unknown) => pushes.push(params));
    let reconnected = false;
    connection.on('reconnect', () => { reconnected = true; });
    connection.ready();
    connection.sendToolsList().catch(() => {});
    await waitFor(() => reconnected, 5000, 'reconnect after crash');
    // Admitted now, it would meet the empty grant and be refused; held, it
    // meets the grant the host establishes.
    connection.emit('push-event', { n: 1 });
    assert.deepStrictEqual(pushes, [], 'data traffic is held after the boundary');
    connection.establishGrant(new CapabilityGrant(new Set(['pushEvents']), []));
    connection.ready();
    assert.deepStrictEqual(pushes, [{ n: 1 }], 'and delivered against the new grant');
  });

  it('drops a server request held across a transport boundary, and never answers one on the next transport', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    connection.establishGrant(new CapabilityGrant(new Set(['inferenceRequest']), []));
    type Responder = { id: unknown; respond: (result: unknown) => void; respondError: (code: number, message: string) => void };
    const requests: Responder[] = [];
    connection.on('inference-request', (_params: unknown, responder: Responder) => {
      requests.push(responder);
    });
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    connection.ready();
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    // Two requests are admitted and their handlers still hold the responders;
    // a third is held while the data plane is paused (a quiesce).
    serverSends({ id: 5, method: 'inference/request', params: { n: 5 } });
    serverSends({ id: 6, method: 'inference/request', params: { n: 6 } });
    assert.equal(requests.length, 2);
    connection.pauseDataPlane();
    serverSends({ id: 7, method: 'inference/request', params: { n: 7 } });
    assert.equal(requests.length, 2, 'held while paused');

    connection.sendToolsList().catch(() => {});
    await waitFor(() => reconnected === 1, 5000, 'reconnect after crash');
    const written: string[] = [];
    const transport = (connection as unknown as { transport: { writeLine(line: string): void } }).transport;
    const writeLine = transport.writeLine.bind(transport);
    transport.writeLine = (line: string) => { written.push(line); writeLine(line); };

    // The handlers answer their requests after the reconnect, one with a
    // result and one with an error: neither is written.
    requests[0]!.respond({ ok: true });
    requests[1]!.respondError(-32000, 'answered too late');
    connection.establishGrant(new CapabilityGrant(new Set(['inferenceRequest']), []));
    connection.ready();
    assert.equal(requests.length, 2, 'the held request from the closed transport is not admitted on the new one');
    assert.deepStrictEqual(written.filter((line) => /"id":(5|6|7)\b/.test(line)), [], 'nothing answers the closed transport\'s requests');
  });

  it('keeps an incoming message and a push held across a transport boundary, admits them under the next grant, and answers nothing there', async () => {
    // What a server reported about the world isn't sent again by the next
    // process: discord-mcpl advances its watermark as it forwards a message.
    // The dead transport's grant has no pushEvents, so a push admitted under
    // it would be refused: delivered, it was admitted under the next one.
    const grant = () => new CapabilityGrant(new Set(['channels.incoming', 'pushEvents']), []);
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    connection.establishGrant(new CapabilityGrant(new Set(['channels.incoming']), []));
    const incoming: Array<{ params: unknown; respond: (result: unknown) => void }> = [];
    connection.on('channels-incoming', (params: unknown, responder: { respond: (result: unknown) => void }) => {
      incoming.push({ params, respond: responder.respond });
    });
    const pushes: unknown[] = [];
    connection.on('push-event', (params: unknown) => pushes.push(params));
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    connection.ready();
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    // A quiesce holds the data plane while a member's message and a push arrive.
    connection.pauseDataPlane();
    serverSends({ id: 9, method: 'channels/incoming', params: { messages: [{ id: 'held-1' }] } });
    serverSends({ method: 'push/event', params: { n: 1 } });
    assert.equal(incoming.length + pushes.length, 0, 'held while paused');

    connection.sendToolsList().catch(() => {});
    await waitFor(() => reconnected === 1, 5000, 'reconnect after crash');
    const written: string[] = [];
    const transport = (connection as unknown as { transport: { writeLine(line: string): void } }).transport;
    const writeLine = transport.writeLine.bind(transport);
    transport.writeLine = (line: string) => { written.push(line); writeLine(line); };
    assert.equal(incoming.length + pushes.length, 0, 'still held until the planes open');

    connection.establishGrant(grant());
    connection.ready();
    assert.deepStrictEqual(incoming.map((message) => message.params), [{ messages: [{ id: 'held-1' }] }], 'delivered under the new grant');
    assert.deepStrictEqual(pushes, [{ n: 1 }]);
    incoming[0]!.respond({ ok: true });
    assert.deepStrictEqual(written.filter((line) => /"id":9\b/.test(line)), [], 'its answer is not written to the next transport');
  });

  it('says what it refused when the next grant refuses a kept incoming message, whose refusal can\'t be answered', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    connection.establishGrant(new CapabilityGrant(new Set(['channels.incoming', 'pushEvents']), []));
    const incoming: unknown[] = [];
    connection.on('channels-incoming', (params: unknown) => { incoming.push(params); });
    const pushes: unknown[] = [];
    connection.on('push-event', (params: unknown) => pushes.push(params));
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    connection.ready();
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    connection.pauseDataPlane();
    serverSends({ id: 9, method: 'channels/incoming', params: { messages: [{ id: 'held-1' }] } });
    serverSends({ method: 'push/event', params: { n: 1 } });

    connection.sendToolsList().catch(() => {});
    await waitFor(() => reconnected === 1, 5000, 'reconnect after crash');
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      // The next process's policy grants pushes only.
      connection.establishGrant(new CapabilityGrant(new Set(['pushEvents']), []));
      connection.ready();
    } finally {
      console.error = consoleError;
    }
    assert.deepStrictEqual(incoming, [], 'refused under the next grant');
    assert.deepStrictEqual(pushes, [{ n: 1 }]);
    assert.ok(logged.some((line) => /not answering request 9 with error -32002 \(channels-incoming rejected: capability "channels\.incoming" not in the effective grant\): the transport it came on has closed/.test(line)),
      logged.join('\n'));
  });

  it('admits a kept incoming message after the next transport registers its channel, rather than refusing it as unknown', async () => {
    // A bridge's first exchange registers its channels and forwards its
    // backlog together. The boundary drops the dead transport's registration
    // and keeps its message; the next process registers the channel again,
    // behind the kept message, and the registry refuses a message for a
    // channel it doesn't know (§14.5), so that registration goes first.
    const grant = () => new CapabilityGrant(new Set(['channels.register', 'channels.incoming']), []);
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    const traces: Array<{ type: string; reason?: unknown }> = [];
    const admitted: Array<{ messageId?: unknown }> = [];
    const server = {
      grant: grant(),
      async sendChannelsOpen() { return {}; },
      async sendChannelsClose() { return {}; },
    };
    const registry = new ChannelRegistry(
      { getServer: () => server } as never,
      {} as never,
      (event) => admitted.push(event as { messageId?: unknown }),
      (event) => traces.push(event),
    );
    connection.on('channels-register', (params: unknown, responder: unknown) => {
      void registry.handleRegister('flaky', params as never, responder as never);
    });
    connection.on('channels-incoming', (params: unknown, responder: unknown) => {
      void registry.handleIncoming('flaky', params as never, responder as never);
    });
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    const register = (id: number) => serverSends({
      id, method: 'channels/register', params: { channels: [{ id: 'room', type: 'text', direction: 'bidirectional' }] },
    });
    // The first exchange, held while its planes are closed, then the transport drops.
    register(1);
    serverSends({
      id: 2,
      method: 'channels/incoming',
      params: { messages: [{ channelId: 'room', messageId: 'kept-1', content: [{ type: 'text', text: 'hello' }] }] },
    });
    connection.sendToolsList().catch(() => {});
    await waitFor(() => reconnected === 1, 5000, 'reconnect after crash');
    // The next process registers the channel again.
    register(3);
    const consoleError = console.error;
    console.error = () => {};
    try {
      connection.establishGrant(grant());
      connection.ready();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = consoleError;
    }
    assert.deepStrictEqual(traces.filter((trace) => trace.type === 'mcpl:channel-incoming-rejected'), [], 'not refused as an unknown channel');
    assert.deepStrictEqual(admitted.map((event) => event.messageId), ['kept-1']);
  });

  async function keptIncomingSetup() {
    const grant = () => new CapabilityGrant(new Set(['channels.register', 'channels.incoming']), []);
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    const traces: Array<{ type: string; reason?: unknown }> = [];
    const admitted: Array<{ messageId?: unknown }> = [];
    const server = { grant: grant(), async sendChannelsOpen() { return {}; }, async sendChannelsClose() { return {}; } };
    const registry = new ChannelRegistry(
      { getServer: () => server } as never,
      {} as never,
      (event) => admitted.push(event as { messageId?: unknown }),
      (event) => traces.push(event),
    );
    // Each registration as it reaches the registry, by request id.
    const registered: unknown[] = [];
    connection.on('channels-register', (params: unknown, responder: unknown) => {
      registered.push((responder as { id?: unknown } | undefined)?.id);
      void registry.handleRegister('flaky', params as never, responder as never);
    });
    connection.on('channels-changed', (params: unknown, responder: unknown) => {
      void registry.handleChanged('flaky', params as never, responder as never);
    });
    connection.on('channels-incoming', (params: unknown, responder: unknown) => {
      void registry.handleIncoming('flaky', params as never, responder as never);
    });
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    const register = (id: number) => serverSends({
      id, method: 'channels/register', params: { channels: [{ id: 'room', type: 'text', direction: 'bidirectional' }] },
    });
    const incoming = (id: number, messageId: string) => serverSends({
      id, method: 'channels/incoming', params: { messages: [{ channelId: 'room', messageId, content: [{ type: 'text', text: 'hello' }] }] },
    });
    const removeChannel = (id: number, channel: string) =>
      serverSends({ id, method: 'channels/changed', params: { removed: [channel] } });
    const removeRoom = (id: number) => removeChannel(id, 'room');
    const addRoom = (id: number) => serverSends({
      id, method: 'channels/changed', params: { added: [{ id: 'room', type: 'text', direction: 'bidirectional' }] },
    });
    register(1);
    incoming(2, 'kept-1');
    connection.sendToolsList().catch(() => {});
    await waitFor(() => reconnected === 1, 5000, 'reconnect after crash');
    registered.length = 0;
    const rejected = () => traces.filter((trace) => trace.type === 'mcpl:channel-incoming-rejected');
    return { grant, admitted, rejected, register, incoming, removeRoom, removeChannel, addRoom, registered };
  }

  it("lets a registration pass what its own transport sent before it, once a kept message is held", async () => {
    const { grant, admitted, rejected, register, incoming } = await keptIncomingSetup();
    // The next process sends a message for the channel before it registers it.
    incoming(3, 'new-1');
    register(4);
    const consoleError = console.error;
    console.error = () => {};
    try {
      connection!.establishGrant(grant());
      connection!.ready();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = consoleError;
    }
    assert.deepStrictEqual(rejected(), [], 'neither message is refused as an unknown channel');
    assert.deepStrictEqual(admitted.map((event) => event.messageId), ['kept-1', 'new-1']);
  });

  it("doesn't move a registration past a removal, so what the transport sent before the removal is admitted", async () => {
    const { grant, admitted, rejected, register, incoming, removeRoom } = await keptIncomingSetup();
    // The next process registers the channel, sends a message in it, and
    // then removes it, all while the kept message is held.
    register(3);
    incoming(4, 'new-1');
    removeRoom(5);
    const consoleError = console.error;
    console.error = () => {};
    try {
      connection!.establishGrant(grant());
      connection!.ready();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = consoleError;
    }
    assert.deepStrictEqual(rejected(), [], 'no message is refused as an unknown channel');
    assert.deepStrictEqual(admitted.map((event) => event.messageId), ['kept-1', 'new-1']);
  });

  it('keeps a registration sent after a removal behind it, so a kept message for its channel is admitted first and refused', async () => {
    const { grant, admitted, rejected, register, removeChannel, registered } = await keptIncomingSetup();
    // The next process removes another channel, and only then registers the
    // kept message's channel.
    removeChannel(3, 'elsewhere');
    register(4);
    const consoleError = console.error;
    console.error = () => {};
    try {
      connection!.establishGrant(grant());
      connection!.ready();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = consoleError;
    }
    assert.deepStrictEqual(registered, [4], 'the registration is admitted, after the removal');
    assert.deepStrictEqual(admitted, [], 'the kept message went first');
    assert.equal(rejected().length, 1, 'and was refused as an unknown channel');
  });

  it('moves a channels/changed that only adds channels ahead of a kept message, as a registration', async () => {
    const { grant, admitted, rejected, addRoom } = await keptIncomingSetup();
    addRoom(3);
    const consoleError = console.error;
    console.error = () => {};
    try {
      connection!.establishGrant(grant());
      connection!.ready();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = consoleError;
    }
    assert.deepStrictEqual(rejected(), [], 'not refused as an unknown channel');
    assert.deepStrictEqual(admitted.map((event) => event.messageId), ['kept-1']);
  });

  it('during a quiesce, admits a removal as the control plane opens, ahead of a kept message for its channel, which is refused as the data plane opens', async () => {
    const { grant, admitted, rejected, register, removeRoom, registered } = await keptIncomingSetup();
    register(3);
    removeRoom(4);
    const consoleError = console.error;
    console.error = () => {};
    try {
      connection!.establishGrant(grant());
      connection!.readyControlPlane();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(registered, [3], 'the registration is admitted as the control plane opens');
      assert.equal(admitted.length, 0, 'the kept message waits for the data plane');
      connection!.ready();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = consoleError;
    }
    assert.deepStrictEqual(admitted, []);
    assert.equal(rejected().length, 1, 'the removal went first, so the kept message is refused as an unknown channel');
  });

  it('during a quiesce, admits the registration as the control plane opens and the kept message once the data plane does', async () => {
    const { grant, admitted, rejected, register, registered } = await keptIncomingSetup();
    register(3);
    const consoleError = console.error;
    console.error = () => {};
    try {
      connection!.establishGrant(grant());
      connection!.readyControlPlane();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(registered, [3], 'the registration is admitted as the control plane opens');
      assert.equal(admitted.length, 0, 'the kept message waits for the data plane');
      connection!.ready();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = consoleError;
    }
    assert.deepStrictEqual(rejected(), []);
    assert.deepStrictEqual(admitted.map((event) => event.messageId), ['kept-1']);
  });

  it('a transport boundary crossed during a flush holds the rest of the snapshot to the boundary rule', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    connection.establishGrant(new CapabilityGrant(new Set(['channels.incoming', 'inferenceRequest', 'pushEvents']), []));
    const seen: string[] = [];
    let closing: Promise<void> | undefined;
    // A listener that closes the connection while the flush is still going.
    connection.on('channels-incoming', () => { seen.push('incoming'); closing = connection!.close(); });
    connection.on('inference-request', () => { seen.push('inference'); });
    connection.on('push-event', () => { seen.push('push'); });
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    serverSends({ id: 10, method: 'channels/incoming', params: { messages: [{ id: 'm' }] } });
    serverSends({ id: 11, method: 'inference/request', params: { n: 11 } });
    serverSends({ method: 'push/event', params: { n: 12 } });
    serverSends({ method: 'tools/observe', params: { rules: [] } });
    serverSends({ id: 13, method: 'inference/request', params: { n: 13 } });
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      connection.ready();
    } finally {
      console.error = consoleError;
    }
    await closing;
    assert.deepStrictEqual(seen, ['incoming'], 'nothing after the boundary reached a listener');
    const held = (connection as unknown as { bufferedEvents: Array<{ event: string }> }).bufferedEvents.map((item) => item.event);
    assert.deepStrictEqual(held, ['push-event'], 'the push is kept, the inference requests and the filter dropped');
    assert.ok(
      logged.some((line) => line.includes('dropped 3 held message(s) from a transport that closed: 2 inference-request, 1 tools-observe')),
      logged.join('\n'),
    );
    connection = null;
  });

  it('drops what a transport that closed during its exchange sent, so the next transport\'s grant never admits it', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    const filters: unknown[] = [];
    connection.on('tools-observe', (params: unknown) => filters.push(params));
    const registrations: unknown[] = [];
    connection.on('channels-register', (params: unknown) => registrations.push(params));
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    connection.ready();
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    connection.sendToolsList().catch(() => {});
    await waitFor(() => reconnected === 1, 5000, 'first reconnect');
    // The fresh transport sends its filter and a channel registration right
    // after initialize, while its exchange holds both planes, and then dies
    // before the exchange settles.
    serverSends({ method: 'tools/observe', params: { rules: [{ tool: 'old-process' }] } });
    serverSends({ id: 7, method: 'channels/register', params: { channels: [{ id: 'old-room', type: 'text', direction: 'bidirectional' }] } });
    connection.sendToolsList().catch(() => {});
    await waitFor(() => reconnected === 2, 5000, 'second reconnect');
    connection.establishGrant(new CapabilityGrant(new Set(['toolLifecycle.observe', 'channels.register']), []));
    connection.ready();
    assert.deepStrictEqual(filters, [], 'the closed transport\'s filter is not admitted under the next grant');
    assert.deepStrictEqual(registrations, [], 'nor is its channel registration');
    // The planes are open under the new grant: the next process's own are admitted.
    serverSends({ method: 'tools/observe', params: { rules: [{ tool: 'new-process' }] } });
    serverSends({ id: 8, method: 'channels/register', params: { channels: [{ id: 'new-room', type: 'text', direction: 'bidirectional' }] } });
    assert.deepStrictEqual(filters, [{ rules: [{ tool: 'new-process' }] }]);
    assert.deepStrictEqual(registrations, [{ channels: [{ id: 'new-room', type: 'text', direction: 'bidirectional' }] }]);
  });

  it('a close during a reconnect\'s handshake closes the new transport instead of adopting it', async () => {
    // Flag file absent: the initial connect fails and we get a stub that
    // reconnects in the background.
    connection = await McplServerConnection.connectWithReconnect(makeConfig({ reconnectIntervalMs: 20 }), HOST_CAPS);
    const statics = McplServerConnection as unknown as { handshake: (...args: unknown[]) => Promise<unknown> };
    const handshake = statics.handshake;
    let release!: (value: unknown) => void;
    let started = false;
    let closedNew = false;
    statics.handshake = () => {
      started = true;
      return new Promise((resolve) => { release = resolve; });
    };
    try {
      await waitFor(() => started, 5000, 'a reconnect handshake in flight');
      const reconnected: unknown[] = [];
      connection.on('reconnect', (p: unknown) => reconnected.push(p));
      // close() owns the handshake in flight: it settles only once that
      // handshake has, and then closes the transport it brought.
      let closeSettled = false;
      const closing = connection.close().finally(() => { closeSettled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(closeSettled, false, 'close() waits for the handshake it owns');
      release({
        transport: { close: async () => { closedNew = true; }, on: () => {}, writeLine: () => {} },
        capabilities: { version: '0.5' },
        droppedCapabilities: [],
        mcpToolsAdvertised: false,
      });
      await closing;
      await waitFor(() => closedNew, 2000, 'the new transport closed');
      assert.deepStrictEqual(reconnected, [], 'nothing is emitted for it');
      assert.strictEqual(connection.isConnected, false);
      assert.strictEqual(connection.willReconnect, false);
    } finally {
      statics.handshake = handshake;
      connection = null;
    }
  });
});

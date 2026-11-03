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

  it('readied between transports, as a gate readies every connection, keeps what a boundary kept for the next grant', async () => {
    const grant = () => new CapabilityGrant(new Set(['channels.incoming', 'pushEvents']), []);
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    connection.establishGrant(new CapabilityGrant(new Set(['channels.incoming']), []));
    const delivered: string[] = [];
    connection.on('channels-incoming', () => delivered.push('incoming'));
    connection.on('push-event', () => delivered.push('push'));
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    connection.ready();
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    // A quiesce holds the data plane while a member's message and a push arrive.
    connection.pauseDataPlane();
    serverSends({ method: 'channels/incoming', params: { messages: [{ id: 'held-1' }] } });
    serverSends({ method: 'push/event', params: { n: 1 } });
    // The transport closes; a gate completing then readies this connection
    // too, between transports, under the empty grant the boundary left.
    connection.once('close', () => connection!.ready());
    connection.sendToolsList().catch(() => {});
    await waitFor(() => reconnected === 1, 5000, 'reconnect after crash');
    assert.deepStrictEqual(delivered, [], 'nothing it kept was admitted between transports');

    connection.establishGrant(grant());
    connection.ready();
    assert.deepStrictEqual(delivered, ['incoming', 'push'], 'admitted under the next grant');
  });

  it("readied between transports, lets the host's own reports through while what a boundary kept waits", () => {
    // A connection with no transport, as a drop leaves it until the next one.
    const between = Reflect.construct(McplServerConnection, ['between', null, null]) as McplServerConnection;
    // Closed while it waits for its next transport, as a stub is, and not for
    // good, since it reconnects.
    Object.assign(between as unknown as { closed: boolean; reconnectEnabled: boolean }, { closed: true, reconnectEnabled: true });
    const delivered: string[] = [];
    between.on('channels-incoming', () => delivered.push('incoming'));
    between.on('push-event', () => delivered.push('push'));
    between.on('stderr', () => delivered.push('stderr'));
    between.on('reconnect-failed', () => delivered.push('reconnect-failed'));
    // Both planes start closed, so a message, a push and a stderr line are
    // held, and a transport boundary keeps them; a failed retry comes after.
    between.emit('channels-incoming', { messages: [{ id: 'kept-1' }] });
    between.emit('push-event', { n: 1 });
    between.emit('stderr', 'a line');
    (between as unknown as { resetPolicyForTransportBoundary(): void }).resetPolicyForTransportBoundary();
    between.emit('reconnect-failed', { error: 'refused', attempt: 1 });
    between.ready();
    assert.deepStrictEqual(delivered, ['stderr', 'reconnect-failed']);
    const held = (between as unknown as { bufferedEvents: Array<{ event: string }> }).bufferedEvents;
    assert.deepStrictEqual(held.map((item) => item.event), ['channels-incoming', 'push-event'], 'held, not refused against the empty grant');
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
    assert.ok(logged.some((line) => /not answering request 9: the transport it came on has closed, with error -32002 "channels-incoming rejected: capability \\"channels\.incoming\\" not in the effective grant"/.test(line)),
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
    return { grant, admitted, rejected, register, incoming, removeRoom, removeChannel, addRoom, registered, registry, serverSends };
  }

  // Opens both planes under the grant, as a reconnect's settled exchange
  // does, and lets the registry's handlers run.
  async function openBothPlanes(grant: () => CapabilityGrant) {
    const consoleError = console.error;
    console.error = () => {};
    try {
      connection!.establishGrant(grant());
      connection!.ready();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = consoleError;
    }
  }

  // The descriptor the registry holds for one of the server's channels.
  function channelOf(registry: ChannelRegistry, id: string): { label?: unknown } | undefined {
    return registry.listChannelsRaw().find((entry) => entry.serverId === 'flaky' && entry.descriptor.id === id)?.descriptor;
  }

  const descriptor = (id: string, label: string) => ({ id, type: 'text', direction: 'bidirectional', label });

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

  it('keeps a removal where it was held, so what the transport sent before it is admitted, its message for that channel included', async () => {
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

  it('moves a registration ahead of a removal of another channel, so a kept message for its channel is admitted', async () => {
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
    assert.deepStrictEqual(registered, [4], 'the registration is admitted');
    assert.deepStrictEqual(rejected(), [], 'not refused as an unknown channel');
    assert.deepStrictEqual(admitted.map((event) => event.messageId), ['kept-1']);
  });

  it("keeps a registration behind a removal of its own channel, so that channel's removal and re-registration stay in order", async () => {
    const { grant, admitted, rejected, register, removeRoom, registered, registry } = await keptIncomingSetup();
    // The next process removes the kept message's channel, and then
    // registers it again.
    removeRoom(3);
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
    assert.deepStrictEqual(registered, [4], 'the registration is admitted');
    assert.ok(
      registry.listChannelsRaw().some((channel) => channel.serverId === 'flaky' && channel.descriptor.id === 'room'),
      'the channel is registered at the end, as the server last said: its registration came after its removal',
    );
    assert.deepStrictEqual(admitted, [], 'the kept message went ahead of both');
    assert.equal(rejected().length, 1, 'and was refused as an unknown channel');
  });

  for (const [what, later] of [
    ['a registration', { method: 'channels/register', params: { channels: [descriptor('room', 'second')] } }],
    ['an update', { method: 'channels/changed', params: { updated: [descriptor('room', 'second')] } }],
  ] as const) {
    it(`keeps ${what} of a channel behind a change that adds it and removes another, so the server's later descriptor stands`, async () => {
      const { grant, serverSends, registry } = await keptIncomingSetup();
      // The next process adds the kept message's channel in a change that
      // also removes another channel, and then writes it again.
      serverSends({
        id: 3,
        method: 'channels/changed',
        params: { added: [descriptor('room', 'first')], removed: ['elsewhere'] },
      });
      serverSends({ id: 4, ...later });
      await openBothPlanes(grant);
      assert.equal(channelOf(registry, 'room')?.label, 'second', 'the later write is the one that stands');
    });
  }

  it('keeps a channels/changed that adds a channel back behind the removal of that channel', async () => {
    const { grant, removeRoom, addRoom, registry } = await keptIncomingSetup();
    removeRoom(3);
    addRoom(4);
    await openBothPlanes(grant);
    assert.ok(channelOf(registry, 'room'), 'the channel is registered at the end, as the server last said');
  });

  it("keeps a registration behind an earlier registration held back that names its channel, so the later descriptor stands", async () => {
    const { grant, removeRoom, serverSends, registry } = await keptIncomingSetup();
    // The second registration stays behind the removal of the kept
    // message's channel, which it names, and so does the third, which
    // names another channel the second names.
    removeRoom(3);
    serverSends({ id: 4, method: 'channels/register', params: { channels: [descriptor('room', 'first'), descriptor('other', 'first')] } });
    serverSends({ id: 5, method: 'channels/register', params: { channels: [descriptor('other', 'second')] } });
    await openBothPlanes(grant);
    assert.equal(channelOf(registry, 'other')?.label, 'second', 'the later registration is the one that stands');
  });

  it('keeps a removal that names its channel as a number where it was held, as the registry removes that channel', async () => {
    const { grant, admitted, rejected, register, serverSends, registry } = await keptIncomingSetup();
    // The next process registers two channels, sends a message in one, and
    // then removes it, naming it as a number.
    register(3);
    serverSends({ id: 4, method: 'channels/register', params: { channels: [descriptor('5', 'five')] } });
    serverSends({
      id: 5,
      method: 'channels/incoming',
      params: { messages: [{ channelId: '5', messageId: 'new-5', content: [{ type: 'text', text: 'hello' }] }] },
    });
    serverSends({ id: 6, method: 'channels/changed', params: { removed: [5] } });
    await openBothPlanes(grant);
    assert.deepStrictEqual(rejected(), [], 'no message is refused as an unknown channel');
    assert.deepStrictEqual(admitted.map((event) => event.messageId), ['kept-1', 'new-5']);
    assert.equal(channelOf(registry, '5'), undefined, 'and the removal took the channel at the end');
  });

  it('a removal named by an object, whose string form can throw, keeps a flush from neither ordering nor admitting what it holds', async () => {
    // A JSON object whose toString isn't a function makes String() throw.
    const { grant, admitted, rejected, register, serverSends, registry } = await keptIncomingSetup();
    // The registry refuses such a removal by throwing; the framework contains
    // what an inbound handler throws, and so does this listener.
    connection!.removeAllListeners('channels-changed');
    connection!.on('channels-changed', (params: unknown, responder: unknown) => {
      registry.handleChanged('flaky', params as never, responder as never).catch(() => {});
    });
    serverSends({ id: 3, method: 'channels/changed', params: { removed: [{ toString: 1 }] } });
    register(4);
    await openBothPlanes(grant);
    assert.deepStrictEqual(rejected(), [], 'the kept message is not refused as an unknown channel');
    assert.deepStrictEqual(admitted.map((event) => event.messageId), ['kept-1'], 'the registration was moved ahead of it, and it is admitted');
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

  it('admits an ordinary held snapshot, with nothing kept, in the order the server sent it', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    const order: string[] = [];
    connection.on('channels-incoming', () => order.push('incoming'));
    connection.on('channels-changed', () => order.push('changed'));
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    // Held while the planes are closed, with no transport boundary between.
    serverSends({ method: 'channels/incoming', params: { messages: [{ channelId: 'room', messageId: 'm-1', content: [{ type: 'text', text: 'hello' }] }] } });
    serverSends({ method: 'channels/changed', params: { updated: [descriptor('room', 'renamed')] } });
    connection.establishGrant(new CapabilityGrant(new Set(['channels.register', 'channels.incoming']), []));
    connection.ready();
    assert.deepStrictEqual(order, ['incoming', 'changed']);
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

  // #387's budget of 10,000 held requests is for requests a live server
  // waits on. A request a transport boundary keeps has no server waiting, its
  // answer bound to a transport that's gone, so it's counted apart, with a
  // bound of its own; one the boundary drops leaves the count.
  const incoming = (id: number) => ({ messages: [{ channelId: 'room', messageId: `m${id}`, content: [] }] });
  async function heldAcrossBoundary(method: string, params: (id: number) => unknown, count = 10_000) {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    const dead = (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport;
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      // Held while both planes are closed, as after connect.
      for (let id = 1; id <= count; id++) serverSends({ id, method, params: params(id) });
      connection.sendToolsList().catch(() => {});
      await waitFor(() => reconnected === 1, 5000, 'reconnect after crash');
    } finally {
      console.error = consoleError;
    }
    const written: string[] = [];
    const transport = (connection as unknown as { transport: { writeLine(line: string): void } }).transport;
    const writeLine = transport.writeLine.bind(transport);
    transport.writeLine = (line: string) => { written.push(line); writeLine(line); };
    const held = () => (connection as unknown as { bufferedEvents: Array<{ event: string }> }).bufferedEvents.map((item) => item.event);
    const lateSends = (message: Record<string, unknown>) => dead.emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    return { serverSends, lateSends, logged, written, held };
  }

  /** Opens both planes under a grant of `capabilities` and returns the
   *  messageIds of the incoming messages the flush admits, in order. */
  function admittedIds(c: McplServerConnection | null, capabilities = ['channels.incoming']): string[] {
    const ids: string[] = [];
    c!.on('channels-incoming', (params: unknown) => { ids.push((params as { messages: Array<{ messageId: string }> }).messages[0]!.messageId); });
    c!.establishGrant(new CapabilityGrant(new Set(capabilities), []));
    const consoleError = console.error;
    console.error = () => {};
    try { c!.ready(); } finally { console.error = consoleError; }
    return ids;
  }

  it('keeps the incoming messages a transport boundary keeps out of the next transport\'s budget: after 10,000 kept, its request is held', async () => {
    const { serverSends, written, held } = await heldAcrossBoundary('channels/incoming', incoming);
    assert.equal(held().length, 10_000, 'every incoming message is kept');
    serverSends({ id: 10_001, method: 'channels/incoming', params: incoming(10_001) });
    assert.deepStrictEqual(written, [], 'nothing refused');
    assert.equal(held().length, 10_001);
  });

  it("admits the next process's channel registration ahead of 10,000 kept messages", async () => {
    const { serverSends, written } = await heldAcrossBoundary('channels/incoming', incoming);
    serverSends({ id: 10_001, method: 'channels/register', params: { channels: [{ id: 'room', type: 'text', direction: 'bidirectional' }] } });
    assert.deepStrictEqual(written, [], 'the registration is held, not refused');
    const order: string[] = [];
    connection!.on('channels-register', () => { order.push('register'); });
    connection!.on('channels-incoming', () => { order.push('incoming'); });
    connection!.establishGrant(new CapabilityGrant(new Set(['channels.register', 'channels.incoming']), []));
    connection!.ready();
    assert.equal(order.length, 10_001);
    assert.equal(order[0], 'register', 'admitted before what was kept');
  });

  it('drops and logs a request read from the closed transport past the kept bound of 10,000', async () => {
    const { lateSends, held } = await heldAcrossBoundary('channels/incoming', incoming);
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      lateSends({ id: 10_001, method: 'channels/incoming', params: incoming(10_001) });
    } finally {
      console.error = consoleError;
    }
    assert.equal(held().length, 10_000, 'not held');
    assert.ok(logged.some((line) => line.includes('kept-request bound (10000) — dropped 1 request(s) a closed transport left')), logged.join('\n'));
  });

  it('keeps the kept bound where boundaries join with no flush between, keeping the earliest', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      // Three rounds of 10,000 held, each ended by a crash and a reconnect,
      // with nothing readying the connection between them.
      for (let round = 1; round <= 3; round++) {
        for (let n = 1; n <= 10_000; n++) serverSends({ id: round * 100_000 + n, method: 'channels/incoming', params: incoming(round * 100_000 + n) });
        connection.sendToolsList().catch(() => {});
        await waitFor(() => reconnected === round, 10_000, `reconnect ${round}`);
      }
    } finally {
      console.error = consoleError;
    }
    assert.equal(logged.filter((line) => line.includes('kept-request bound (10000) — dropped 10000 request(s) a closed transport left')).length, 2, logged.join('\n'));
    // What was kept is what the next grant admits.
    const admitted = admittedIds(connection);
    assert.equal(admitted.length, 10_000);
    assert.equal(admitted[0], 'm100001', 'the earliest are kept');
    assert.equal(admitted[9_999], 'm110000');
  });

  it('counts the requests read from the closed transport toward the kept bound as it holds them', async () => {
    const { lateSends, held } = await heldAcrossBoundary('channels/incoming', incoming, 9_999);
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      lateSends({ id: 20_001, method: 'channels/incoming', params: incoming(20_001) }); // the 10,000th kept
      lateSends({ id: 20_002, method: 'channels/incoming', params: incoming(20_002) }); // past the bound
    } finally {
      console.error = consoleError;
    }
    assert.equal(held().length, 10_000);
    assert.ok(logged.some((line) => line.includes('kept-request bound (10000) — dropped 1 request(s) a closed transport left')), logged.join('\n'));
  });

  it("starts the next pause's counts afresh after a flush", async () => {
    const { serverSends } = await heldAcrossBoundary('channels/incoming', incoming);
    const consoleError = console.error;
    console.error = () => {};
    try {
      connection!.establishGrant(new CapabilityGrant(new Set(['channels.incoming']), []));
      connection!.ready();
      connection!.pauseDataPlane();
      // A notification cap's worth and one more: the oldest goes.
      for (let n = 1; n <= 1_001; n++) serverSends({ method: 'channels/incoming', params: incoming(30_000 + n) });
    } finally {
      console.error = consoleError;
    }
    const admitted = admittedIds(connection);
    assert.equal(admitted.length, 1_000);
    assert.equal(admitted[0], 'm30002', 'the oldest went');
  });

  it('keeps notifications out of the kept bound where boundaries join', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    const consoleError = console.error;
    console.error = () => {};
    try {
      // 10,000 requests and then five notifications, kept; then 10,000 more
      // requests, kept at a second boundary with no flush between.
      for (let n = 1; n <= 10_000; n++) serverSends({ id: n, method: 'channels/incoming', params: incoming(n) });
      for (let n = 1; n <= 5; n++) serverSends({ method: 'channels/incoming', params: incoming(50_000 + n) });
      connection.sendToolsList().catch(() => {});
      await waitFor(() => reconnected === 1, 10_000, 'reconnect 1');
      for (let n = 1; n <= 10_000; n++) serverSends({ id: 100_000 + n, method: 'channels/incoming', params: incoming(100_000 + n) });
      connection.sendToolsList().catch(() => {});
      await waitFor(() => reconnected === 2, 10_000, 'reconnect 2');
    } finally {
      console.error = consoleError;
    }
    const admitted: Array<{ responder: unknown }> = [];
    connection.on('channels-incoming', (_params: unknown, responder: unknown) => { admitted.push({ responder }); });
    connection.establishGrant(new CapabilityGrant(new Set(['channels.incoming']), []));
    console.error = () => {};
    try { connection.ready(); } finally { console.error = consoleError; }
    assert.equal(admitted.filter((item) => item.responder === undefined).length, 5, 'the five notifications stay');
    assert.equal(admitted.length, 10_005);
  });

  it('holds a notification read from the closed transport as kept, outside both request counts', async () => {
    const { lateSends, held } = await heldAcrossBoundary('channels/incoming', incoming);
    lateSends({ method: 'channels/incoming', params: incoming(40_001) });
    assert.equal(held().length, 10_001);
    const c = connection as unknown as { bufferedEvents: Array<{ kept?: true; args: unknown[] }>; keptRequests: number; heldRequests: number };
    const last = c.bufferedEvents.at(-1)!;
    assert.equal(last.kept, true);
    assert.equal(last.args[1], undefined, 'no responder');
    assert.deepEqual([c.keptRequests, c.heldRequests], [10_000, 0]);
  });

  it("a control-plane flush keeps what a boundary kept out of the next transport's budget", async () => {
    const { serverSends, written } = await heldAcrossBoundary('channels/incoming', incoming);
    // A quiesce opens the control plane first; the kept messages are data.
    connection!.establishGrant(new CapabilityGrant(new Set(['channels.incoming']), []));
    const delivered: unknown[] = [];
    connection!.on('channels-incoming', (params: unknown) => { delivered.push(params); });
    connection!.readyControlPlane();
    assert.equal(delivered.length, 0, 'held again');
    serverSends({ id: 10_001, method: 'channels/incoming', params: incoming(10_001) });
    assert.deepStrictEqual(written, [], 'nothing refused');
    assert.equal(admittedIds(connection).length, 10_001, 'all of it is admitted once the data plane opens');
  });

  it("holds the next transport's notifications beside 10,000 kept requests, dropping none", async () => {
    const { serverSends } = await heldAcrossBoundary('channels/incoming', incoming);
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      for (let n = 1; n <= 5; n++) serverSends({ method: 'channels/incoming', params: incoming(20_000 + n) });
    } finally {
      console.error = consoleError;
    }
    assert.equal(logged.some((line) => line.includes('buffered-event cap')), false, logged.join('\n'));
    assert.equal(admittedIds(connection).length, 10_005, 'none dropped');
  });

  it('frees the budget of the requests a transport boundary drops: after 10,000 held inference requests, the next transport\'s request is held', async () => {
    const { serverSends, logged, written } = await heldAcrossBoundary('inference/request', (id) => ({ n: id }));
    assert.ok(
      logged.some((line) => line.includes('dropped 10000 held message(s) from a transport that closed: 10000 inference-request')),
      logged.join('\n'),
    );
    serverSends({ id: 10_001, method: 'channels/incoming', params: incoming(10_001) });
    assert.deepStrictEqual(written, [], 'nothing refused');
    let requests = 0;
    connection!.on('inference-request', () => { requests++; });
    assert.deepStrictEqual(admittedIds(connection, ['channels.incoming', 'inferenceRequest']), ['m10001'], 'the next transport\'s message, held');
    assert.equal(requests, 0, 'none of the dropped requests is admitted');
  });

  it('a transport boundary crossed during a flush holds the rest of the snapshot to the boundary rule', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    connection.establishGrant(new CapabilityGrant(new Set(['channels.incoming', 'inferenceRequest', 'pushEvents']), []));
    const seen: string[] = [];
    // A listener during which the transport drops, while the flush is still
    // going: the connection will reconnect, so what the server reported about
    // the world is kept for the next transport's grant.
    connection.on('channels-incoming', () => {
      seen.push('incoming');
      (connection as unknown as { transport: { emit(event: string, info: unknown): void } }).transport.emit('close', { code: 1, signal: null });
    });
    connection.on('inference-request', () => { seen.push('inference'); });
    connection.on('push-event', () => { seen.push('push'); });
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
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
    assert.deepStrictEqual(seen, ['incoming'], 'nothing after the boundary reached a listener');
    assert.ok(
      logged.some((line) => line.includes('dropped 3 held message(s) from a transport that closed: 2 inference-request, 1 tools-observe')),
      logged.join('\n'),
    );
    // The next transport's grant admits what the boundary kept.
    await waitFor(() => reconnected === 1, 5000, 'reconnect after the drop');
    connection.establishGrant(new CapabilityGrant(new Set(['channels.incoming', 'inferenceRequest', 'pushEvents']), []));
    connection.ready();
    assert.deepStrictEqual(seen, ['incoming', 'push'], 'the push is kept, the inference requests and the filter dropped');
  });

  it("sends a streamed inference's chunks only on the transport its request came on", async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    connection.establishGrant(new CapabilityGrant(new Set(['inferenceRequest']), []));
    let responder: { sendChunk(params: { requestId: number; index: number; delta: string }): void } | undefined;
    connection.on('inference-request', (_params: unknown, given: typeof responder) => { responder = given; });
    connection.ready();
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    type Wire = { emit(event: string, line: string): void; writeLine(line: string): void };
    const transportOf = () => (connection as unknown as { transport: Wire }).transport;
    const chunks: string[] = [];
    const watch = (wire: Wire, name: string) => {
      const write = wire.writeLine.bind(wire);
      wire.writeLine = (line: string) => {
        if ((JSON.parse(line) as { method?: string }).method === 'inference/chunk') chunks.push(name);
        write(line);
      };
    };
    const first = transportOf();
    watch(first, 'first');
    first.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'inference/request', params: { featureSet: 'x', messages: [] } }));
    responder!.sendChunk({ requestId: 5, index: 0, delta: 'a' });
    connection.sendToolsList().catch(() => {});
    await waitFor(() => reconnected === 1, 5000, 'reconnect after crash');
    watch(transportOf(), 'next');
    // The stream outlived its transport; the next process numbers its own
    // requests afresh and may be using 5.
    responder!.sendChunk({ requestId: 5, index: 1, delta: 'b' });
    assert.deepStrictEqual(chunks, ['first']);
  });

  it("gives a line read from a transport after its close the boundary's rule: an incoming message is kept for the next grant, and a registration is dropped", async (t) => {
    const grant = () => new CapabilityGrant(new Set(['channels.register', 'channels.incoming']), []);
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    const traces: Array<{ type: string }> = [];
    const admitted: Array<{ messageId?: unknown }> = [];
    const server = { grant: grant(), async sendChannelsOpen() { return {}; }, async sendChannelsClose() { return {}; } };
    const registry = new ChannelRegistry(
      { getServer: () => server } as never,
      {} as never,
      (event) => admitted.push(event as { messageId?: unknown }),
      (event) => traces.push(event),
    );
    const registered: unknown[] = [];
    connection.on('channels-register', (params: unknown, responder: unknown) => {
      registered.push((responder as { id?: unknown } | undefined)?.id);
      void registry.handleRegister('flaky', params as never, responder as never);
    });
    connection.on('channels-incoming', (params: unknown, responder: unknown) => {
      void registry.handleIncoming('flaky', params as never, responder as never);
    });
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    let closed = 0;
    connection.on('close', () => { closed++; });
    // Serving, both planes open under its grant, as when a server dies.
    connection.establishGrant(grant());
    connection.ready();
    type Wire = { emit(event: string, line: string): void };
    const sends = (wire: Wire, message: Record<string, unknown>) => wire.emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    const dead = (connection as unknown as { transport: Wire }).transport;
    const room = { id: 'room', type: 'text', direction: 'bidirectional' };
    connection.sendToolsList().catch(() => {});
    await waitFor(() => closed === 1, 5000, 'the transport closed');
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    // Lines the child wrote before it exited, read after the exit.
    sends(dead, { id: 1, method: 'channels/register', params: { channels: [room] } });
    sends(dead, { id: 2, method: 'channels/incoming', params: { messages: [{ channelId: 'room', messageId: 'late-1', content: [{ type: 'text', text: 'hello' }] }] } });
    // A gate readies every connection, this one between transports too.
    connection.ready();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(traces.filter((trace) => trace.type === 'mcpl:channel-incoming-rejected'), [], 'not refused against the empty grant');
    assert.equal(admitted.length, 0, 'held, not admitted');
    assert.ok(logged.some((line) => line.includes('dropped a message read after its transport closed: method channels/register')), logged.join('\n'));
    // The next process registers the channel, and its grant arrives.
    await waitFor(() => reconnected === 1, 5000, 'reconnect after crash');
    sends((connection as unknown as { transport: Wire }).transport, { id: 3, method: 'channels/register', params: { channels: [room] } });
    connection.establishGrant(grant());
    connection.ready();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(registered, [3], "the dead process's registration was dropped");
    assert.deepStrictEqual(admitted.map((event) => event.messageId), ['late-1'], 'admitted under the next grant');
  });

  it("drops a ping, a removed method or an unknown method read after its transport's close, answering none of them", async (t) => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    let closed = 0;
    connection.on('close', () => { closed++; });
    type Wire = { emit(event: string, line: string): void };
    const dead = (connection as unknown as { transport: Wire }).transport;
    connection.sendToolsList().catch(() => {});
    await waitFor(() => closed === 1, 5000, 'the transport closed');
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const written: string[] = [];
    (dead as unknown as { writeLine(line: string): void }).writeLine = (line: string) => { written.push(line); };
    const heldBefore = (connection as unknown as { bufferedEvents: unknown[] }).bufferedEvents.length;
    for (const [id, method] of [[7, 'ping'], [8, 'featureSets/changed'], [9, 'scope/elevate'], [10, 'no/such-method']] as const) {
      dead.emit('line', JSON.stringify({ jsonrpc: '2.0', id, method }));
    }
    for (const method of ['ping', 'featureSets/changed', 'scope/elevate', 'no/such-method']) {
      assert.ok(logged.some((line) => line.includes(`dropped a message read after its transport closed: method ${method}`)), `${method}:\n${logged.join('\n')}`);
    }
    assert.equal(logged.some((line) => line.includes('answered -32601')), false, 'nothing is said to have been answered');
    assert.equal((connection as unknown as { bufferedEvents: unknown[] }).bufferedEvents.length, heldBefore, 'nothing is held');
    assert.deepEqual(written, [], 'nothing is written');
  });

  it('surfaces a stateful response read after its transport closed as an orphaned response, as any late answer is', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect({ ...makeConfig(), reconnect: false }, HOST_CAPS);
    connection.ready();
    let closed = 0;
    connection.on('close', () => { closed++; });
    const orphaned: Array<{ id: unknown; hadState: boolean }> = [];
    connection.on('orphaned-response', (info: { id: unknown; hadState: boolean }) => { orphaned.push(info); });
    type Wire = { emit(event: string, line: string): void };
    const dead = (connection as unknown as { transport: Wire }).transport;
    connection.sendToolsList().catch(() => {});
    await waitFor(() => closed === 1, 5000, 'the transport closed');
    dead.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 41, result: { state: { step: 2 } } }));
    assert.deepEqual(orphaned.map(({ id, hadState }) => ({ id, hadState })), [{ id: 41, hadState: true }]);
  });

  it("never lets a response read from a transport after its close answer a request of the next transport's", async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    type Wire = { emit(event: string, line: string): void };
    const dead = (connection as unknown as { transport: Wire }).transport;
    connection.sendToolsList().catch(() => {});
    await waitFor(() => reconnected === 1, 5000, 'reconnect after crash');
    // The next transport's first request, which this fixture never answers;
    // the next transport numbers its requests from 1 again.
    let settled = false;
    connection.sendManifestRequest().then(() => { settled = true; }, () => { settled = true; });
    const next = (connection as unknown as { transport: { writeLine(line: string): void } }).transport;
    const answered: unknown[] = [];
    const write = next.writeLine.bind(next);
    next.writeLine = (line: string) => {
      const sent = JSON.parse(line) as { id?: unknown; method?: unknown };
      if (sent.method === undefined) answered.push(sent.id);
      write(line);
    };
    const consoleError = console.error;
    console.error = () => {};
    try {
      dead.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 1, result: { version: '0.5' } }));
      // Nor is anything the dead process asked answered on the next transport.
      dead.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }));
      dead.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'no/such-method' }));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = consoleError;
    }
    assert.equal(settled, false, "the dead transport's response answers nothing");
    assert.deepStrictEqual(answered, [], 'neither its ping nor its unknown method is answered on the next transport');
  });

  it("never takes a response read from a transport after its close for a late answer to the next transport's request", async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    connection.ready();
    let reconnected = 0;
    connection.on('reconnect', () => { reconnected++; });
    const orphaned: unknown[] = [];
    connection.on('orphaned-response', (info: unknown) => { orphaned.push(info); });
    type Wire = { emit(event: string, line: string): void };
    const dead = (connection as unknown as { transport: Wire }).transport;
    connection.sendToolsList().catch(() => {});
    await waitFor(() => reconnected === 1, 5000, 'reconnect after crash');
    // A request of the next transport's that timed out, numbered as the dead
    // process's was.
    const records = (connection as unknown as { orphanedRequests: Map<number, { method: string }> }).orphanedRequests;
    records.set(1, { method: 'push/render' });
    dead.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    // Reported or held: the reconnect closed the control plane, so an audit
    // would wait there for the next grant.
    const held = (connection as unknown as { bufferedEvents: Array<{ event: string }> }).bufferedEvents.map((item) => item.event);
    assert.deepStrictEqual([...orphaned, ...held.filter((event) => event === 'orphaned-response')], [], 'not reported as the late answer to it');
    assert.deepStrictEqual(records.get(1), { method: 'push/render' }, 'and its record stays for its own answer');
  });

  it('drops and logs the world messages a connection closed for good held at its boundary, since no grant will come', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect({ ...makeConfig(), reconnect: false }, HOST_CAPS);
    let closed = 0;
    connection.on('close', () => { closed++; });
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      serverSends({ method: 'channels/incoming', params: incoming(1) }); // held while both planes are closed, as after connect
      connection.sendToolsList().catch(() => {});
      await waitFor(() => closed === 1, 5000, 'the transport closed');
    } finally {
      console.error = consoleError;
    }
    const held = (connection as unknown as { bufferedEvents: Array<{ event: string }> }).bufferedEvents.map((item) => item.event);
    assert.equal(held.includes('channels-incoming'), false, held.join(', '));
    assert.ok(logged.some((line) => line.includes('dropped 1 held message(s) from a transport that closed, with no transport to come: 1 channels-incoming')), logged.join('\n'));
  });

  it('drops and logs the world messages a connection held when the host closes it', async () => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect(makeConfig(), HOST_CAPS);
    const serverSends = (message: Record<string, unknown>) =>
      (connection as unknown as { transport: { emit(event: string, line: string): void } }).transport
        .emit('line', JSON.stringify({ jsonrpc: '2.0', ...message }));
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      serverSends({ id: 5, method: 'channels/incoming', params: incoming(5) }); // held while both planes are closed, as after connect
      await connection.close();
    } finally {
      console.error = consoleError;
    }
    const held = (connection as unknown as { bufferedEvents: Array<{ event: string }> }).bufferedEvents.map((item) => item.event);
    assert.equal(held.includes('channels-incoming'), false, held.join(', '));
    assert.ok(logged.some((line) => line.includes('dropped 1 held message(s) from a transport that closed, with no transport to come: 1 channels-incoming')), logged.join('\n'));
  });

  it('drops and logs a world message a connection closed for good reads after its close, since no grant will come', async (t) => {
    writeFileSync(FLAG_FILE, '');
    connection = await McplServerConnection.connect({ ...makeConfig(), reconnect: false }, HOST_CAPS);
    let closed = 0;
    connection.on('close', () => { closed++; });
    type Wire = { emit(event: string, line: string): void };
    const dead = (connection as unknown as { transport: Wire }).transport;
    connection.sendToolsList().catch(() => {});
    await waitFor(() => closed === 1, 5000, 'the transport closed');
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const heldBefore = (connection as unknown as { bufferedEvents: unknown[] }).bufferedEvents.length;
    dead.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'channels/incoming', params: incoming(3) }));
    assert.equal((connection as unknown as { bufferedEvents: unknown[] }).bufferedEvents.length, heldBefore, 'not held');
    assert.ok(logged.some((line) => line.includes('dropped a message read after its transport closed, with no transport to come: method channels/incoming')), logged.join('\n'));
  });

  it("logs a request id it can't answer as the server's field, escaped", (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const between = Reflect.construct(McplServerConnection, ['between', null, null]) as McplServerConnection;
    // An answer for a request that came on an earlier transport.
    (between as unknown as { sendErrorResponse(id: string, code: number, message: string, data: unknown, epoch: number): void })
      .sendErrorResponse('9\nforged line', -32002, 'refused', undefined, -1);
    assert.equal(logged.length, 1);
    assert.ok(!logged[0].includes('\n'), logged[0]);
    assert.ok(logged[0].includes('not answering request "9\\nforged\\u0020line"'), logged[0]);
    // Refused while the connection is closed, between transports, it's logged too.
    (between as unknown as { closed: boolean }).closed = true;
    (between as unknown as { sendResponse(id: number, result: unknown, epoch: number): void }).sendResponse(10, {}, -1);
    (between as unknown as { sendErrorResponse(id: number, code: number, message: string, data: unknown, epoch: number): void })
      .sendErrorResponse(11, -32002, 'refused', undefined, -1);
    assert.equal(logged.length, 3);
    assert.ok(logged[1].includes('not answering request 10: the transport it came on has closed'), logged[1]);
    assert.ok(logged[2].includes('not answering request 11: the transport it came on has closed, with error -32002'), logged[2]);
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

});

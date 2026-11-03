/**
 * MCPL per-request timeout (6.2): a live-but-stuck server — accepts a
 * request, never responds, never closes its transport — must not freeze the
 * awaiting caller forever. sendRequest rejects after requestTimeoutMs with a
 * descriptive error; the framework maps that rejection to an isError
 * tool_result, so the agent turn completes instead of hanging.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { McplRequestError, McplServerConnection } from '../src/mcpl/server-connection.js';
import type { McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';

// What the stub's tools/list answer says when it wrote a held reply ahead of it.
const RELEASED = 'released a held reply first';

// Stdio server: answers initialize and tools/list, but swallows tools/call —
// the "zulip HTML-error / event-loop-wedge" profile (alive, deaf). A test can
// make it hold a reply in `held` instead, and the next tools/list then writes
// that reply ahead of its own, so the late reply comes when the test asks.
const HUNG_SERVER = `
let buf = '';
let held = null;
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const reply = (result, id = m.id) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
    if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: {} });
    else if (m.method === 'tools/list') {
      const released = held !== null;
      if (held) { reply(held.result, held.id); held = null; }
      reply({ tools: [{ name: 'stuck', description: released ? '${RELEASED}' : 's', inputSchema: { type: 'object' } }] });
    }
    // tools/call: deliberately NO response, connection stays open.
  }
});
setInterval(() => {}, 1 << 30); // stay alive
`;

const HOST_CAPS: McplHostCapabilities = {
  version: '0.4',
  pushEvents: true,
  contextHooks: { beforeInference: true },
  featureSets: true,
};

function config(overrides?: Partial<McplServerConfig>): McplServerConfig {
  return {
    id: 'hung',
    command: process.execPath,
    args: ['-e', HUNG_SERVER],
    ...overrides,
  };
}

/** Lift a connection's request timeout, so the tools/list that releases a
 *  held reply has no watchdog of its own to race. It sets a private field,
 *  which sendRequest reads for each request; the check fails the test if the
 *  field is renamed, where the lift would otherwise set nothing. */
function liftRequestTimeout(c: McplServerConnection): void {
  assert.ok(Object.hasOwn(c, 'requestTimeoutMs'), 'the connection still has its requestTimeoutMs field');
  (c as unknown as { requestTimeoutMs: number }).requestTimeoutMs = 0;
}

let connection: McplServerConnection | null = null;
afterEach(async () => {
  await connection?.close();
  connection = null;
});

test('tools/call against a hung server rejects within the configured timeout', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 250 }), HOST_CAPS);
  connection.ready();

  const started = Date.now();
  await assert.rejects(
    connection.sendToolsCall('stuck', {}),
    (err: Error) => {
      // The agent's words name no method; the log keeps it and the id.
      assert.match(err.message, /^The "hung" server didn't answer within 0\.25 seconds, so whether the request took effect is unknown/);
      assert.ok(!err.message.includes('tools/call'), err.message);
      assert.ok(errors.mock.calls.some((call) => /^MCPL server "hung" did not respond to tools\/call \(id=\d+\) within 250ms/
        .test(String(call.arguments[0]))), 'the operator log has the method and id');
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 200 && elapsed < 5000, `rejected in ${elapsed}ms (expected ~250ms)`);

  // The connection survives the abandoned request: a request the server DOES
  // answer still works afterwards.
  const list = await connection.sendToolsList();
  assert.equal(list.tools[0]?.name, 'stuck');
});

test('a request the server answers in time is unaffected by the timeout', async () => {
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 2000 }), HOST_CAPS);
  connection.ready();

  const list = await connection.sendToolsList();
  assert.equal(list.tools.length, 1);
});

test('requestTimeoutMs: 0 disables the per-request watchdog', async (t) => {
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 0 }), HOST_CAPS);
  connection.ready();

  // On a mocked clock, past the longest delay setTimeout takes (2^31 - 1 ms):
  // a watchdog that 0 failed to disable, the 60 s default or any other, would
  // have fired by then.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const call = connection.sendToolsCall('stuck', {}).catch(() => {}).finally(() => { settled = true; });
  try {
    t.mock.timers.tick(2_147_483_647);
    await new Promise((r) => setImmediate(r));
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(settled, false, 'with timeout disabled the request stays pending');

  // Cleanup: closing the connection rejects the pending request.
  await connection.close();
  connection = null;
  await call;
  assert.equal(settled, true);
});

test('requestTimeoutMs: 0 leaves channels/publish its own deadline, whose expiry is a no-response', async () => {
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 0 }), HOST_CAPS);
  connection.ready();
  // The default is 60 s; the test shortens it rather than wait.
  (connection as unknown as { publishDeadlineMs: number }).publishDeadlineMs = 150;
  const started = Date.now();
  await assert.rejects(
    connection.sendChannelsPublish({ conversationId: 'c', channelId: 'x', content: [{ type: 'text', text: 'hi' }] }),
    (err: Error) => {
      assert.ok(err instanceof McplRequestError);
      assert.equal(err.outcome, 'no-response');
      assert.match(err.message, /^The "hung" server didn't answer within 0\.15 seconds, so whether the request took effect is unknown/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000);
});

test('the timeout error warns the model the tool may have completed server-side', async () => {
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 150 }), HOST_CAPS);
  connection.ready();
  await assert.rejects(
    connection.sendToolsCall('stuck', {}),
    (err: Error) => {
      // The model reads this string; it must not imply the call was cancelled.
      assert.match(err.message, /it was abandoned here, not cancelled, and may still complete on the server/);
      assert.match(err.message, /Check its effect before trying again/);
      return true;
    },
  );
});

// The next three tests hold the server's reply, so a timeout that never fires
// leaves the call pending: the test's own timeout turns that into a failure.
test('a timed-out request that later receives a response does not crash (orphaned response ignored)', { timeout: 30_000 }, async () => {
  // The server holds its tools/call reply until the next tools/list, so the
  // reply comes after the 100ms timeout.
  const SLOW_SERVER = HUNG_SERVER.replace(
    '// tools/call: deliberately NO response, connection stays open.',
    "else if (m.method === 'tools/call') held = { id: m.id, result: { content: [] } };",
  );
  connection = await McplServerConnection.connect(
    { id: 'slow', command: process.execPath, args: ['-e', SLOW_SERVER], requestTimeoutMs: 100 },
    HOST_CAPS,
  );
  connection.ready();

  const orphaned: unknown[] = [];
  connection.on('orphaned-response', (info) => orphaned.push(info));

  await assert.rejects(connection.sendToolsCall('stuck', {}), /didn't answer within/);
  liftRequestTimeout(connection);
  // The next tools/list makes the stub write the late reply ahead of the
  // list's own, on the same stream, so by the time the list resolves the late
  // reply has been handled: ignored, with no event and no crash.
  const list = await connection.sendToolsList();
  assert.equal(list.tools[0]?.description, RELEASED, 'the stub wrote the late reply first');
  assert.deepEqual(orphaned, [], 'a plain late reply is ignored, not surfaced');
});

test('a late STATEFUL orphaned response is surfaced via mcpl:orphaned-response (not silently dropped)', { timeout: 30_000 }, async () => {
  // The server holds a checkpoint-carrying tools/call result until the next
  // tools/list, after a 100ms timeout. The host advanced no checkpoint; the
  // server did. That divergence must be greppable, so the connection emits an
  // event.
  const STATEFUL_SLOW = HUNG_SERVER.replace(
    '// tools/call: deliberately NO response, connection stays open.',
    "else if (m.method === 'tools/call') held = { id: m.id, result: { content: [], state: { checkpoint: 'cp-late', data: { n: 1 } } } };",
  );
  connection = await McplServerConnection.connect(
    { id: 'slow-stateful', command: process.execPath, args: ['-e', STATEFUL_SLOW], requestTimeoutMs: 100 },
    HOST_CAPS,
  );
  connection.ready();

  const orphaned: Array<{ hadState: boolean; hadCheckpoint: boolean }> = [];
  connection.on('orphaned-response', (info) => orphaned.push(info));

  await assert.rejects(connection.sendToolsCall('stuck', {}), /didn't answer within/);
  liftRequestTimeout(connection);
  // The next tools/list releases the late reply ahead of its own answer, so it
  // has been handled by the time the list resolves, and the connection still
  // works afterwards.
  const list = await connection.sendToolsList();
  assert.equal(list.tools[0]?.description, RELEASED, 'the stub wrote the late reply first');

  assert.equal(orphaned.length, 1, 'the dropped stateful response must be surfaced');
  assert.equal(orphaned[0].hadState, true, 'the event records that state was carried');
});

test('a mandatory call deadline overrides requestTimeoutMs: 0 and surfaces its late response', { timeout: 30_000 }, async () => {
  const SLOW_SERVER = HUNG_SERVER.replace(
    '// tools/call: deliberately NO response, connection stays open.',
    "else if (m.method === 'tools/call') held = { id: m.id, result: { content: [] } };",
  );
  connection = await McplServerConnection.connect(
    { id: 'mandatory-deadline', command: process.execPath, args: ['-e', SLOW_SERVER], requestTimeoutMs: 0 },
    HOST_CAPS,
  );
  connection.ready();

  const orphaned: Array<{ method?: string; hadState: boolean }> = [];
  connection.on('orphaned-response', (info) => orphaned.push(info));
  await assert.rejects(
    connection.sendToolsCallWithDeadline('stuck', {}, 75),
    /took effect is unknown.*Check its effect before trying again/i,
  );
  // Only the deadline could settle the call, since the server sends nothing
  // until the next tools/list, which releases the late reply ahead of its own.
  const list = await connection.sendToolsList();
  assert.equal(list.tools[0]?.description, RELEASED, 'the stub wrote the late reply first');

  assert.equal(orphaned.length, 1);
  // The id is the connection's own numbering of the call.
  const { id, ...payload } = orphaned[0] as { id?: unknown };
  assert.equal(typeof id, 'number');
  assert.deepEqual(payload, { method: 'tools/call', hadState: false, hadCheckpoint: false });
});

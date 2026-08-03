/**
 * MCPL per-request timeout (6.2): a live-but-stuck server — accepts a
 * request, never responds, never closes its transport — must not freeze the
 * awaiting caller forever. sendRequest rejects after requestTimeoutMs with a
 * descriptive error; the framework maps that rejection to an isError
 * tool_result, so the agent turn completes instead of hanging.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { McplServerConnection } from '../src/mcpl/server-connection.js';
import type { McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';

// Stdio server: answers initialize and tools/list, but swallows tools/call —
// the "zulip HTML-error / event-loop-wedge" profile (alive, deaf).
const HUNG_SERVER = `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') reply({ capabilities: {} });
    else if (m.method === 'tools/list') reply({ tools: [{ name: 'stuck', description: 's', inputSchema: { type: 'object' } }] });
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

let connection: McplServerConnection | null = null;
afterEach(async () => {
  await connection?.close();
  connection = null;
});

test('tools/call against a hung server rejects within the configured timeout', async () => {
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 250 }), HOST_CAPS);
  connection.ready();

  const started = Date.now();
  await assert.rejects(
    connection.sendToolsCall('stuck', {}),
    (err: Error) => {
      assert.match(err.message, /did not respond to tools\/call/);
      assert.match(err.message, /250ms/);
      assert.match(err.message, /hung/);
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

test('requestTimeoutMs: 0 disables the per-request watchdog', async () => {
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 0 }), HOST_CAPS);
  connection.ready();

  let settled = false;
  const call = connection.sendToolsCall('stuck', {}).catch(() => {}).finally(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(settled, false, 'with timeout disabled the request stays pending');

  // Cleanup: closing the connection rejects the pending request.
  await connection.close();
  connection = null;
  await call;
  assert.equal(settled, true);
});

test('the timeout error warns the model the tool may have completed server-side', async () => {
  connection = await McplServerConnection.connect(config({ requestTimeoutMs: 150 }), HOST_CAPS);
  connection.ready();
  await assert.rejects(
    connection.sendToolsCall('stuck', {}),
    (err: Error) => {
      // The model reads this string; it must not imply the call was cancelled.
      assert.match(err.message, /may still have completed server-side/);
      assert.match(err.message, /verify state before retrying/);
      return true;
    },
  );
});

test('a timed-out request that later receives a response does not crash (orphaned response ignored)', async () => {
  // Server that answers tools/call after 500ms — beyond a 100ms timeout.
  const SLOW_SERVER = HUNG_SERVER.replace(
    '// tools/call: deliberately NO response, connection stays open.',
    "else if (m.method === 'tools/call') setTimeout(() => reply({ content: [] }), 500);",
  );
  connection = await McplServerConnection.connect(
    { id: 'slow', command: process.execPath, args: ['-e', SLOW_SERVER], requestTimeoutMs: 100 },
    HOST_CAPS,
  );
  connection.ready();

  await assert.rejects(connection.sendToolsCall('stuck', {}), /did not respond/);
  // Wait past the server's late response; it must be ignored, not crash.
  await new Promise((r) => setTimeout(r, 600));
  const list = await connection.sendToolsList();
  assert.equal(list.tools.length, 1);
});

test('a late STATEFUL orphaned response is surfaced via mcpl:orphaned-response (not silently dropped)', async () => {
  // Server answers tools/call after 500ms with a checkpoint-carrying result —
  // beyond a 100ms timeout. The host advanced no checkpoint; the server did.
  // That divergence must be greppable, so the connection emits an event.
  const STATEFUL_SLOW = HUNG_SERVER.replace(
    '// tools/call: deliberately NO response, connection stays open.',
    "else if (m.method === 'tools/call') setTimeout(() => reply({ content: [], state: { checkpoint: 'cp-late', data: { n: 1 } } }), 500);",
  );
  connection = await McplServerConnection.connect(
    { id: 'slow-stateful', command: process.execPath, args: ['-e', STATEFUL_SLOW], requestTimeoutMs: 100 },
    HOST_CAPS,
  );
  connection.ready();

  const orphaned: Array<{ hadState: boolean; hadCheckpoint: boolean }> = [];
  connection.on('orphaned-response', (info) => orphaned.push(info));

  await assert.rejects(connection.sendToolsCall('stuck', {}), /did not respond/);
  await new Promise((r) => setTimeout(r, 600));

  assert.equal(orphaned.length, 1, 'the dropped stateful response must be surfaced');
  assert.equal(orphaned[0].hadState, true, 'the event records that state was carried');

  // The connection still works afterwards.
  const list = await connection.sendToolsList();
  assert.equal(list.tools.length, 1);
});

test('a mandatory call deadline overrides requestTimeoutMs: 0 and surfaces its late response', async () => {
  const SLOW_SERVER = HUNG_SERVER.replace(
    '// tools/call: deliberately NO response, connection stays open.',
    "else if (m.method === 'tools/call') setTimeout(() => reply({ content: [] }), 300);",
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
    /outcome is unknown.*verify state before retrying/i,
  );
  await new Promise((r) => setTimeout(r, 350));

  assert.deepEqual(orphaned, [{
    method: 'tools/call',
    hadState: false,
    hadCheckpoint: false,
    id: 1,
  }]);
});

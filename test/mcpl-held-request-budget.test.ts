/**
 * What a connection holds while a plane is paused (#387, issue #122). Requests
 * and notifications are bounded apart: past 10,000 held requests a new one is
 * refused at once with -32000, never dropped, and past 1,000 held
 * notifications the oldest notification is dropped. A server that pipelines
 * requests without waiting for answers no longer grows the host's memory
 * without bound, and held requests never crowd out notifications.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport } from '../src/mcpl/transport.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';

const REQUESTS = 10_000;
const NOTIFICATIONS = 1_000;
const BUSY = `the host is busy: ${REQUESTS} of this server's requests are already waiting; send this one again later`;

class LineTransport extends McplTransport {
  constructor() { super(); }
  readonly kind = 'stdio' as const;
  readonly lines: string[] = [];
  writeLine(line: string): void { this.lines.push(line); }
  async close(): Promise<void> {}
}

/** A connection on the real routing, its planes closed as at startup, with a
 *  push/event listener that records what reaches it. */
function pausedConnection(t: TestContext) {
  const transport = new LineTransport();
  const connection = new (McplServerConnection as any)('srv', null, transport) as McplServerConnection;
  connection.establishGrant(new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []));
  const delivered: Array<string | number | undefined> = [];
  connection.on('push-event', (params: { eventId: string }, responder?: { id: string | number }) => {
    delivered.push(responder ? responder.id : params.eventId);
  });
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  let next = 1;
  const requests = (count: number) => {
    for (let i = 0; i < count; i++) {
      const id = next++;
      transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id, method: 'push/event', params: { featureSet: 'fs', eventId: `r${id}` } }));
    }
  };
  const notifications = (count: number, from = 1) => {
    for (let i = from; i < from + count; i++) {
      transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'push/event', params: { featureSet: 'fs', eventId: `n${i}` } }));
    }
  };
  const answers = () => transport.lines.map((line) => JSON.parse(line));
  const held = () => (connection as any).bufferedEvents.length as number;
  return { connection, delivered, logged, requests, notifications, answers, held };
}

test('past 10,000 held requests, a new one is refused at once with -32000; the held ones are delivered in order when the plane opens', (t) => {
  const { connection, delivered, logged, requests, answers, held } = pausedConnection(t);
  requests(REQUESTS);
  assert.equal(held(), REQUESTS);
  assert.deepEqual(answers(), []);
  requests(101);
  assert.equal(answers().length, 101);
  assert.deepEqual(answers()[0], { jsonrpc: '2.0', id: REQUESTS + 1, error: { code: -32000, message: BUSY } });
  assert.deepEqual(answers()[100], { jsonrpc: '2.0', id: REQUESTS + 101, error: { code: -32000, message: BUSY } });
  assert.equal(held(), REQUESTS);
  // One line for the first refusal, then one per hundred.
  assert.deepEqual(logged, [1, 101].map((n) =>
    `[mcpl] srv: held-request budget (${REQUESTS}) — refused ${n} request(s) with -32000 while the plane is paused`));
  connection.ready();
  assert.equal(delivered.length, REQUESTS);
  assert.deepEqual(delivered.slice(0, 2), [1, 2]);
  assert.equal(delivered.at(-1), REQUESTS);
});

test('notifications are counted apart from held requests: with 10,000 requests held, a notification is still held, and 1,000 notifications are kept, newest last', (t) => {
  const { connection, delivered, logged, requests, notifications, answers, held } = pausedConnection(t);
  requests(REQUESTS);
  notifications(NOTIFICATIONS + 1);
  // Nothing refused: notifications don't spend the requests' budget.
  assert.deepEqual(answers(), []);
  assert.deepEqual(logged, [`[mcpl] srv: buffered-event cap (${NOTIFICATIONS}) — dropped 1 responder-less event(s) while the plane is paused`]);
  // The oldest notification made room for the newest.
  assert.equal(held(), REQUESTS + NOTIFICATIONS);
  connection.ready();
  const deliveredNotifications = delivered.filter((id) => typeof id === 'string');
  assert.equal(deliveredNotifications.length, NOTIFICATIONS);
  assert.equal(deliveredNotifications[0], 'n2');
  assert.equal(deliveredNotifications.at(-1), `n${NOTIFICATIONS + 1}`);
});

test('the budget counts what is held: requests held again by a control-plane flush still count, and an open plane frees the budget for the next pause', (t) => {
  const { connection, delivered, logged, requests, answers, held } = pausedConnection(t);
  requests(REQUESTS / 2);
  // The control plane opens and the data plane stays paused, as during a
  // reconnect or an awareness drain: every push is held again.
  connection.readyControlPlane();
  assert.equal(held(), REQUESTS / 2);
  requests(REQUESTS / 2);
  assert.deepEqual(answers(), [], 'the half held again and the half sent since fill the budget exactly');
  requests(1);
  assert.deepEqual(answers().map((answer) => [answer.id, answer.error?.code]), [[REQUESTS + 1, -32000]]);
  connection.ready();
  assert.equal(delivered.length, REQUESTS);
  // A quiesce pauses the data plane again; the budget is whole.
  connection.pauseDataPlane();
  requests(REQUESTS);
  assert.equal(answers().length, 1, 'no new refusal');
  assert.equal(held(), REQUESTS);
  // This pause's first refusal is logged too.
  logged.length = 0;
  requests(1);
  assert.equal(answers().length, 2);
  assert.deepEqual(logged, [`[mcpl] srv: held-request budget (${REQUESTS}) — refused 1 request(s) with -32000 while the plane is paused`]);
});

test('a request held again during ready()\'s own flush, when a listener pauses the plane, counts toward the budget', (t) => {
  const { connection, delivered, requests, answers, held } = pausedConnection(t);
  // The first push's handler pauses the data plane, as a quiesce begun from
  // inside a handler would, so the rest of ready()'s snapshot is held again.
  connection.once('push-event', () => connection.pauseDataPlane());
  requests(2);
  connection.ready();
  assert.deepEqual(delivered, [1]);
  assert.equal(held(), 1);
  requests(REQUESTS - 1);
  assert.deepEqual(answers(), [], 'the one held again and the ones sent since fill the budget exactly');
  requests(1);
  assert.deepEqual(answers().map((answer) => [answer.id, answer.error?.code]), [[REQUESTS + 2, -32000]]);
});

/**
 * REVIEW 5: cap_clear / cap_status must be reachable ONLY through
 * Host-authenticated command provenance. The single choke point is the
 * connection-level admission gate (server-connection.ts): a `host/command`
 * from a server whose OPERATOR config did not set allowHostCommands is
 * refused with CAPABILITY_DISABLED before handleHostCommand ever runs —
 * host-owned authority, not a capability, so no server-side params, model
 * tool, or §6.2 negotiation can confer it (PR #79 review blocker 9).
 * handleHostCommand's only caller is the MCPL request path behind this gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { CAPABILITY_DISABLED } from '../src/mcpl/errors.js';

function makeConnection(allowHostCommands: boolean) {
  const conn = Object.create(McplServerConnection.prototype) as any;
  EventEmitter.call(conn);
  conn.id = 'test-server';
  conn.allowHostCommands = allowHostCommands;
  conn.controlPlaneReady = true;
  conn.dataPlaneReady = true;
  conn.grant = { has: () => true }; // irrelevant: host/command has no capability path
  return conn;
}

const CAP_CLEAR_PARAMS = { command: 'cap_clear', agentName: 'cairn', requesterName: 'not-an-operator' };

test('cap_clear via host/command from a non-authorized server is refused at admission', () => {
  const conn = makeConnection(false);
  let handled = 0;
  conn.on('host-command', () => { handled++; });
  const errors: Array<{ code: number; message: string }> = [];
  const responder = { respondError: (code: number, message: string) => { errors.push({ code, message }); } };

  conn.emit('host-command', CAP_CLEAR_PARAMS, responder);

  assert.equal(handled, 0, 'the framework handler must never see it');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, CAPABILITY_DISABLED);
  assert.match(errors[0].message, /allowHostCommands/);
});

test('caller-asserted params cannot confer authority — only the operator config flag admits', () => {
  const conn = makeConnection(false);
  let handled = 0;
  conn.on('host-command', () => { handled++; });
  const responder = { respondError: () => {} };
  // A hostile server asserting operator-looking params changes nothing: the
  // gate reads ONLY the connection's operator-config flag.
  conn.emit('host-command', {
    ...CAP_CLEAR_PARAMS, allowHostCommands: true, requesterId: 'antra', authenticated: true,
  }, responder);
  assert.equal(handled, 0);

  // The same command through a connection the OPERATOR authorized is admitted.
  const authorized = makeConnection(true);
  let ok = 0;
  authorized.on('host-command', () => { ok++; });
  authorized.emit('host-command', CAP_CLEAR_PARAMS, { respondError: () => {} });
  assert.equal(ok, 1, 'operator-config provenance admits');
});

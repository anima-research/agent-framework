import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  connectionEnded,
  endedTooSoon,
  LASTING_FLOOR_MS,
  lastingAfterMs,
  MAX_TIMER_MS,
  reconnectDelay,
  reconnectTimingProblems,
  reconnectTimings,
} from '../src/mcpl/protocol-family.js';

test('a connection lasts once it has lived as long as the cap, clamped to a timer\'s limit, and never under 300 s', () => {
  assert.equal(LASTING_FLOOR_MS, 300_000);
  assert.equal(lastingAfterMs(300_000), 300_000);
  assert.equal(lastingAfterMs(60_000), 300_000);
  assert.equal(lastingAfterMs(600_000), 600_000);
  assert.equal(lastingAfterMs(Infinity), MAX_TIMER_MS);
  assert.equal(lastingAfterMs(10 * MAX_TIMER_MS), MAX_TIMER_MS);
});

test("a connection's end before it lasted is the failure of the attempt that made it; one that lasted starts the count afresh", () => {
  assert.deepEqual(connectionEnded(1_000, 0, 300_000), { failures: 1, attempt: 0 });
  assert.deepEqual(connectionEnded(1_000, 3, 300_000), { failures: 4, attempt: 3 });
  assert.deepEqual(connectionEnded(299_999, 3, 60_000), { failures: 4, attempt: 3 });
  assert.deepEqual(connectionEnded(300_000, 3, 60_000), { failures: 0 });
  assert.deepEqual(connectionEnded(599_999, 3, 600_000), { failures: 4, attempt: 3 });
  assert.deepEqual(connectionEnded(600_000, 3, 600_000), { failures: 0 });
  assert.deepEqual(connectionEnded(30 * 86_400_000, 3, Infinity), { failures: 0 });
});

test('a short end says how long the connection lived, and how it closed as its transport says it', () => {
  assert.equal(endedTooSoon(300), 'connected, then closed after 0.3 s');
  assert.equal(endedTooSoon(12_400, { transport: 'stdio', code: 3 }), 'connected, then closed after 12 s (exit code 3)');
  assert.equal(endedTooSoon(1_000, { transport: 'stdio', code: null, signal: 'SIGTERM' }), 'connected, then closed after 1.0 s (signal SIGTERM)');
  assert.equal(endedTooSoon(1_000, { transport: 'websocket', code: 4001 }), 'connected, then closed after 1.0 s (close code 4001)');
  assert.equal(endedTooSoon(1_000, { transport: 'stdio', code: null, signal: null, byHost: true }), 'connected, then closed by this host after 1.0 s');
});

test('a short end\'s whole seconds are the seconds it lived, rounded down, so one just under the threshold never reads as reaching it', () => {
  assert.equal(endedTooSoon(299_700), 'connected, then closed after 299 s');
});

test('the backoff doubles from the base, is capped before its jitter, and never asks a timer to wait past its limit', () => {
  const at = (failures: number, base: number, cap: number, random: number) => reconnectDelay(failures, base, cap, () => random);
  assert.equal(at(0, 1000, 300_000, 0.5), 1000);
  assert.equal(at(1, 1000, 300_000, 0.5), 1000);
  assert.equal(at(3, 1000, 300_000, 0.5), 4000);
  assert.equal(at(3, 1000, 300_000, 0), 3000);
  assert.equal(at(3, 1000, 300_000, 1), 5000);
  assert.equal(at(20, 1000, 300_000, 0.5), 300_000);
  assert.equal(at(20, 1000, 300_000, 1), 375_000);
  assert.equal(at(5, 1000, 500, 0.5), 500);
  assert.equal(at(40, 5000, Infinity, 1), MAX_TIMER_MS);
  assert.equal(at(40, 5000, 10 * MAX_TIMER_MS, 1), MAX_TIMER_MS);
});

test('the timings are read as before this change: left out or null is the default, anything else as a number', () => {
  assert.deepEqual(reconnectTimings({}), { intervalMs: 5000, maxIntervalMs: 300_000 });
  assert.deepEqual(reconnectTimings({ reconnectIntervalMs: null, reconnectMaxIntervalMs: null } as never), { intervalMs: 5000, maxIntervalMs: 300_000 });
  assert.deepEqual(reconnectTimings({ reconnectIntervalMs: '250' as never, reconnectMaxIntervalMs: Infinity }), { intervalMs: 250, maxIntervalMs: Infinity });
  assert.ok(Number.isNaN(reconnectTimings({ reconnectIntervalMs: Symbol('x') as never }).intervalMs));
});

test('where the timings are used, a timing read as 0, below 0 or not a number is refused, a number named and anything else by its kind', () => {
  const problems = (fields: Record<string, unknown>, reconnect: boolean | 'left out' = true) =>
    reconnectTimingProblems({ id: 'timed', ...(reconnect === 'left out' ? {} : { reconnect }), ...fields } as never);
  for (const [value, shown] of [[0, '0'], [-5, '-5'], [Number.NaN, 'NaN'], ['abc', 'a string'], ['', 'a string'], [false, 'a boolean'], [{}, 'an object']] as const) {
    const found = problems({ reconnectIntervalMs: value });
    assert.equal(found.length, 1, `${String(value)}: ${found.join(' | ')}`);
    assert.match(found[0]!, /^MCP server "timed": reconnectIntervalMs /);
    assert.ok(found[0]!.includes(`(got ${shown})`), found[0]);
  }
  assert.match(problems({ reconnectMaxIntervalMs: -1 })[0]!, /reconnectMaxIntervalMs .*\(got -1\)/);
  for (const fields of [{}, { reconnectIntervalMs: null }, { reconnectIntervalMs: '300000' }, { reconnectIntervalMs: true }, { reconnectIntervalMs: 0.5 }, { reconnectMaxIntervalMs: Infinity }, { reconnectIntervalMs: 5000, reconnectMaxIntervalMs: 1000 }]) {
    assert.deepEqual(problems(fields), [], JSON.stringify(fields));
  }
  assert.deepEqual(problems({ command: 'server', reconnectIntervalMs: 0 }, false), []);
  assert.deepEqual(problems({ command: 'server', reconnectIntervalMs: 0 }, 'left out'), []);
  assert.deepEqual(problems({ url: 'ws://127.0.0.1:9/mcpl', reconnectIntervalMs: 0 }, false), []);
  assert.equal(problems({ command: 'server', protocol: 'modern', reconnectIntervalMs: 0 }, false).length, 1);
  assert.equal(problems({ url: 'https://127.0.0.1:9/mcp', reconnectMaxIntervalMs: -1 }, 'left out').length, 1);
});

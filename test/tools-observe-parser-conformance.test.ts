/**
 * RFC-007 §6.1/6.6 and §13: strict object admission, Unicode code-point
 * bounds, and filter preservation through the real connection responder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport } from '../src/mcpl/transport.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { parseToolObserveParams, TOOL_OBSERVE_LIMITS } from '../src/mcpl/tool-lifecycle.js';

const LIMIT = TOOL_OBSERVE_LIMITS.stringLength;
const PATTERN_KEYS = ['tool', 'serverTool', 'serverId', 'conversationId'] as const;

test('explicit null params are invalid; omitted params and rules:null retain clear semantics', () => {
  assert.equal(parseToolObserveParams(null).ok, false);
  for (const params of [undefined, {}, { rules: null }, { _meta: {} }]) {
    assert.deepEqual(parseToolObserveParams(params), { ok: true, rules: null });
  }
  assert.deepEqual(parseToolObserveParams({ rules: [] }), { ok: true, rules: [] });
});

test('_meta must be an object before clearing, pausing, or replacing a filter', () => {
  for (const _meta of [null, [], 'scalar', 7, false]) {
    for (const params of [
      { _meta },
      { _meta, rules: null },
      { _meta, rules: [] },
      { _meta, rules: [{ match: {} }] },
    ]) {
      assert.equal(parseToolObserveParams(params).ok, false, JSON.stringify(params));
    }
  }
  assert.deepEqual(parseToolObserveParams({
    _meta: { 'trace/example': { nested: [null, 'valid metadata'] } }, rules: [],
  }), { ok: true, rules: [] });
});

for (const key of PATTERN_KEYS) {
  test(key + ' uses the RFC schema code-point limit, preserving exact pattern text', () => {
    for (const value of ['🙂'.repeat(LIMIT), 'x'.repeat(LIMIT - 2) + 'e\u0301']) {
      const parsed = parseToolObserveParams({ rules: [{ match: { [key]: value } }] });
      assert.ok(parsed.ok);
      assert.equal(parsed.rules?.[0]?.match[key], value);
      const over = parseToolObserveParams({ rules: [{ match: { [key]: value + '🙂' } }] });
      assert.equal(over.ok, false);
      assert.deepEqual(!over.ok && over.data, { limit: 'stringLength' });
    }
  });
}

test('input paths use code points and preserve content while rejecting empty/over-limit paths', () => {
  for (const path of ['🙂'.repeat(LIMIT), 'e\u0301'.repeat(LIMIT / 2)]) {
    const parsed = parseToolObserveParams({ rules: [{ match: {}, input: [path] }] });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.rules?.[0]?.input, [path]);
    const over = parseToolObserveParams({ rules: [{ match: {}, input: [path + 'x'] }] });
    assert.equal(over.ok, false);
    assert.deepEqual(!over.ok && over.data, { limit: 'stringLength' });
  }
  assert.equal(parseToolObserveParams({ rules: [{ match: {}, input: [''] }] }).ok, false);
});

class RecordingTransport extends McplTransport {
  constructor() { super(); }
  readonly kind = 'stdio' as const;
  readonly lines: string[] = [];
  writeLine(line: string): void { this.lines.push(line); }
  async close(): Promise<void> {}
}

function wireHarness() {
  const transport = new RecordingTransport();
  // The public connection factory needs a live peer. Here the real connection
  // routes JSON requests and serializes responses on a recording transport.
  const Connection = McplServerConnection as unknown as new (
    id: string, capabilities: null, transport: McplTransport,
  ) => McplServerConnection;
  const connection = new Connection('observer', null, transport);
  const framework = Object.create(AgentFramework.prototype) as {
    wireMcplEvents(connection: McplServerConnection): void;
  };
  framework.wireMcplEvents(connection);
  connection.establishGrant(new CapabilityGrant(new Set(['toolLifecycle.observe']), []));
  connection.ready();
  let nextId = 1;
  return {
    connection,
    request(params?: unknown) {
      const id = nextId++;
      const before = transport.lines.length;
      transport.emit('line', JSON.stringify({
        jsonrpc: '2.0', id, method: 'tools/observe',
        ...(params === undefined ? {} : { params }),
      }));
      assert.equal(transport.lines.length, before + 1, 'exactly one reply per request');
      const response = JSON.parse(transport.lines.at(-1)!);
      assert.equal(response.id, id);
      return response;
    },
  };
}

test('wire rejection leaves a restrictive filter in force; valid omitted/null-rules clears still work', () => {
  const { connection, request } = wireHarness();
  const restrictive = { rules: [{ match: { tool: 'allowed--*' }, report: false }] };
  assert.deepEqual(request(restrictive).result, {});
  const prior = connection.toolObserveFilter;
  for (const params of [null, { _meta: null }, { _meta: [], rules: null }, { _meta: 'bad', rules: [] }]) {
    assert.equal(request(params).error.code, -32602);
    assert.equal(connection.toolObserveFilter, prior, 'invalid params cannot clear or replace the filter');
  }
  for (const params of [undefined, {}, { rules: null }, { _meta: { source: 'test' }, rules: null }]) {
    assert.deepEqual(request(params).result, {});
    assert.equal(connection.toolObserveFilter, null);
    assert.deepEqual(request(restrictive).result, {});
  }
  assert.deepEqual(request({ rules: [], _meta: {} }).result, {});
  assert.deepEqual(connection.toolObserveFilter, []);
});

test('wire accepts the Unicode boundary and rejects over-limit replacement without changing the filter', () => {
  const { connection, request } = wireHarness();
  const value = '🙂'.repeat(LIMIT);
  const match = Object.fromEntries(PATTERN_KEYS.map((key) => [key, value]));
  assert.deepEqual(request({ rules: [{ match, input: [value] }] }).result, {});
  const prior = connection.toolObserveFilter;
  assert.deepEqual(prior, [{ match, report: true, input: [value] }]);
  const rejected = request({ rules: [{ match: {}, input: [value + '🙂'] }] });
  assert.equal(rejected.error.code, -32602);
  assert.deepEqual(rejected.error.data, { limit: 'stringLength' });
  assert.equal(connection.toolObserveFilter, prior);
});

test('wire capability denial remains ahead of malformed params admission', () => {
  const { connection, request } = wireHarness();
  connection.establishGrant(new CapabilityGrant(new Set(), []));
  const result = request(null);
  assert.equal(result.error.code, -32002);
  assert.equal(connection.toolObserveFilter, null);
});

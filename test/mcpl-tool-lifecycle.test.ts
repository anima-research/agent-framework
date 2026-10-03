/**
 * MCPL RFC-007 tool lifecycle — the host-side decision (grant, narrowing,
 * class exclusions, the server's tools/observe filter, field selection and
 * bounding) and the emitter's pairing (started → one terminal, to exactly the
 * connections opened to, unless their grant no longer covers the call).
 *
 * Test names cite RFC-007 sections; conformance-vector numbers follow the
 * RFC's own list where one applies.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import {
  parseToolObserveParams,
  selectFields,
  boundInput,
  openingFor,
  TOOL_OBSERVE_LIMITS,
  type ToolCallDescriptor,
  type ToolLifecycleConfig,
  type ToolLifecycleParams,
  type ToolObserveRule,
} from '../src/mcpl/tool-lifecycle.js';

const OBSERVE = 'toolLifecycle.observe';
const INPUTS = 'toolLifecycle.inputs';

function observer(id: string, paths: string[], filter: ToolObserveRule[] | null = null) {
  const sent: ToolLifecycleParams[] = [];
  return {
    id,
    grant: new CapabilityGrant(new Set(paths), []),
    toolObserveFilter: filter,
    sendToolLifecycle: (p: ToolLifecycleParams) => { sent.push(p); },
    sent,
  };
}

function rules(raw: unknown): ToolObserveRule[] | null {
  const parsed = parseToolObserveParams({ rules: raw });
  assert.ok(parsed.ok, `rules should parse: ${JSON.stringify(raw)}`);
  return parsed.rules;
}

function call(over: Partial<ToolCallDescriptor> = {}): ToolCallDescriptor {
  return {
    toolCallId: 'toolu_0123456789abcdefghij',
    inferenceId: 'inf_1',
    conversationId: 'scout',
    tool: 'computer--click',
    class: ['computer'],
    serverId: 'computer',
    serverTool: 'click',
    input: { x: 812, y: 440, button: 'left', target: { window_id: 3312, title: 'Invoice.pdf' } },
    ...over,
  };
}

const DEFAULT_INPUTS: ToolLifecycleConfig = { observe: {}, inputs: { classes: 'default' } };

// ── RFC §6.4 steps 1–5, per connection ──────────────────────────────────────

describe('openingFor: grant, narrowing, filter, arguments', () => {
  test('no observe grant → nothing (§4.1)', () => {
    const o = observer('obs', [INPUTS], rules([{ match: {}, input: true }]));
    assert.equal(openingFor(o, DEFAULT_INPUTS, call(), 'started'), null);
  });

  test('vector 1 — observe only, no filter: metadata, no input, no inputWithheld', () => {
    const p = openingFor(observer('obs', [OBSERVE]), undefined, call(), 'started')!;
    assert.deepEqual(Object.keys(p).sort(), [
      'class', 'conversationId', 'inferenceId', 'phase', 'serverId', 'serverTool', 'tool', 'toolCallId',
    ]);
    assert.equal(p.phase, 'started');
    assert.deepEqual(p.class, ['computer']);
  });

  test('vector 2 — both leaves granted, NO filter: still metadata only (§5.1, rev 2)', () => {
    const p = openingFor(observer('obs', [OBSERVE, INPUTS]), DEFAULT_INPUTS, call(), 'started')!;
    assert.equal(p.input, undefined);
    assert.equal(p.inputWithheld, undefined);
  });

  test('vector 3 — filter requests fields, grant allows: projected input, no inputAltered', () => {
    const o = observer('obs', [OBSERVE, INPUTS], rules([{ match: { serverTool: 'click' }, input: ['x', 'y', 'target.window_id'] }]));
    const p = openingFor(o, DEFAULT_INPUTS, call(), 'started')!;
    assert.deepEqual(p.input, { x: 812, y: 440, target: { window_id: 3312 } });
    assert.equal(p.inputAltered, undefined);
  });

  test('inputs narrowed by tool away from the call → inputWithheld (§4.3)', () => {
    const o = observer('obs', [OBSERVE, INPUTS], rules([{ match: {}, input: true }]));
    const p = openingFor(o, { observe: {}, inputs: { tools: ['y--*'] } }, call(), 'started')!;
    assert.equal(p.input, undefined);
    assert.equal(p.inputWithheld, true);
  });

  test('observe narrowed away from the call → nothing', () => {
    const o = observer('obs', [OBSERVE]);
    assert.equal(openingFor(o, { observe: { tools: ['y--*'] } }, call(), 'started'), null);
    assert.equal(openingFor(o, { observe: { classes: ['shell'] } }, call(), 'started'), null);
    assert.ok(openingFor(o, { observe: { classes: ['shell', 'computer'] } }, call(), 'started'));
  });

  test('conversation narrowing is host-side (§4.3, §7.1)', () => {
    const o = observer('obs', [OBSERVE]);
    const cfg: ToolLifecycleConfig = { observe: { conversations: ['scout'] } };
    assert.ok(openingFor(o, cfg, call({ conversationId: 'scout' }), 'started'));
    assert.equal(openingFor(o, cfg, call({ conversationId: 'other' }), 'started'), null);
  });

  test('inputs is never unconditional: no tools/classes term → withheld (§4.3)', () => {
    const o = observer('obs', [OBSERVE, INPUTS], rules([{ match: {}, input: true }]));
    for (const cfg of [{ observe: {} }, { observe: {}, inputs: {} }, { observe: {}, inputs: { conversations: ['*'] } }] as ToolLifecycleConfig[]) {
      const p = openingFor(o, cfg, call(), 'started')!;
      assert.equal(p.input, undefined, JSON.stringify(cfg));
      assert.equal(p.inputWithheld, true, JSON.stringify(cfg));
    }
  });

  test('comms never carries input, whatever the narrowing says (§4.3, §5.4)', () => {
    const o = observer('obs', [OBSERVE, INPUTS], rules([{ match: {}, input: true }]));
    const cfg: ToolLifecycleConfig = { observe: {}, inputs: { classes: ['comms', 'files'], tools: ['*'] } };
    const send = call({ tool: 'disc--send', class: ['comms'], serverId: 'disc', serverTool: 'send', input: { text: 'hi Alice' } });
    const p = openingFor(o, cfg, send, 'started')!;
    assert.equal(p.input, undefined);
    assert.equal(p.inputWithheld, true);
    // Multi-class tools get the union of restrictions (RFC-008 §5.3).
    const sendFile = call({ tool: 'disc--send_file', class: ['files', 'comms'], input: { path: '/x' } });
    assert.equal(openingFor(o, cfg, sendFile, 'started')!.input, undefined);
  });

  test('unclassed never carries input (RFC-008 §5.2)', () => {
    const o = observer('obs', [OBSERVE, INPUTS], rules([{ match: {}, input: true }]));
    const p = openingFor(o, { observe: {}, inputs: { tools: ['*'] } }, call({ class: [] }), 'started')!;
    assert.deepEqual(p.class, []);
    assert.equal(p.input, undefined);
    assert.equal(p.inputWithheld, true);
  });

  test('requested without the inputs grant → no input AND no inputWithheld (§5.1)', () => {
    const o = observer('obs', [OBSERVE], rules([{ match: {}, input: true }]));
    const p = openingFor(o, DEFAULT_INPUTS, call(), 'started')!;
    assert.equal(p.input, undefined);
    assert.equal(p.inputWithheld, undefined);
  });

  test('not requested → no input, no inputWithheld', () => {
    const o = observer('obs', [OBSERVE, INPUTS], rules([{ match: {} }]));
    const p = openingFor(o, DEFAULT_INPUTS, call(), 'started')!;
    assert.equal(p.input, undefined);
    assert.equal(p.inputWithheld, undefined);
  });

  test('own tools are excluded (§7.1)', () => {
    const o = observer('computer', [OBSERVE]);
    assert.equal(openingFor(o, undefined, call(), 'started'), null);
  });

  test('host-implemented tools have no serverId/serverTool', () => {
    const p = openingFor(observer('obs', [OBSERVE]), undefined,
      call({ tool: 'code_execution', class: ['shell'], serverId: undefined, serverTool: undefined }), 'started')!;
    assert.equal('serverId' in p, false);
    assert.equal('serverTool' in p, false);
  });

  test('pending never carries input', () => {
    const o = observer('obs', [OBSERVE, INPUTS], rules([{ match: {}, input: true }]));
    const p = openingFor(o, DEFAULT_INPUTS, call(), 'pending')!;
    assert.equal(p.phase, 'pending');
    assert.equal(p.input, undefined);
    assert.equal(p.inputWithheld, undefined);
  });
});

// ── RFC §6 filter semantics ─────────────────────────────────────────────────

describe('tools/observe filter', () => {
  const shell = call({ tool: 'workbench--bash', class: ['shell'], serverId: 'workbench', serverTool: 'bash', input: { command: 'make' } });
  const blender = call({ tool: 'blender--execute', class: [], serverId: 'blender', serverTool: 'execute', input: { code: 'x' } });
  const say = call({ tool: 'channel_publish', class: ['comms'], serverId: undefined, serverTool: undefined, input: { text: 'hi' } });

  test('a call matching no rule is not reported', () => {
    const o = observer('obs', [OBSERVE], rules([{ match: { tool: 'y--*' } }]));
    assert.equal(openingFor(o, undefined, call(), 'started'), null);
    assert.ok(openingFor(o, undefined, call({ tool: 'y--go' }), 'started'));
  });

  test('first match wins', () => {
    const o = observer('obs', [OBSERVE, INPUTS], rules([
      { match: { tool: 'computer--*' }, input: ['x'] },
      { match: {}, input: true },
    ]));
    assert.deepEqual(openingFor(o, DEFAULT_INPUTS, call(), 'started')!.input, { x: 812 });
  });

  test('report:false carves an exception out of a later catch-all', () => {
    const o = observer('obs', [OBSERVE], rules([{ match: { class: 'comms' }, report: false }, { match: {} }]));
    assert.equal(openingFor(o, undefined, say, 'started'), null);
    assert.ok(openingFor(o, undefined, shell, 'started'));
  });

  test('class rule: matches by effective class; never matches an unclassed tool', () => {
    const o = observer('obs', [OBSERVE], rules([{ match: { class: 'shell' } }]));
    assert.ok(openingFor(o, undefined, shell, 'started'));
    assert.equal(openingFor(o, undefined, blender, 'started'), null);
  });

  test('serverTool / serverId rules never match a host-implemented tool', () => {
    const o = observer('obs', [OBSERVE], rules([{ match: { serverTool: '*' } }]));
    assert.equal(openingFor(o, undefined, say, 'started'), null);
    const o2 = observer('obs', [OBSERVE], rules([{ match: { serverId: '*' } }]));
    assert.equal(openingFor(o2, undefined, say, 'started'), null);
  });

  test('conversationId is a match member (interest, not the boundary)', () => {
    const o = observer('obs', [OBSERVE], rules([{ match: { conversationId: 'scout' } }]));
    assert.ok(openingFor(o, undefined, call(), 'started'));
    assert.equal(openingFor(o, undefined, call({ conversationId: 'x' }), 'started'), null);
  });

  test('rules: [] pauses; null clears back to metadata-only default', () => {
    assert.deepEqual(parseToolObserveParams({ rules: [] }), { ok: true, rules: [] });
    assert.equal(openingFor(observer('obs', [OBSERVE], []), undefined, call(), 'started'), null);
    assert.deepEqual(parseToolObserveParams({ rules: null }), { ok: true, rules: null });
    assert.deepEqual(parseToolObserveParams({}), { ok: true, rules: null });
    assert.deepEqual(parseToolObserveParams(undefined), { ok: true, rules: null });
  });

  test('defaults: report true, input false', () => {
    assert.deepEqual(rules([{ match: {} }]), [{ match: {}, report: true, input: false }]);
  });

  test('malformed requests fail with a reason (§6.6)', () => {
    const bad: unknown[] = [
      'nope',
      { rules: 'x' },
      { rules: [1] },
      { rules: [{}] },
      { rules: [{ match: { module: 'x' } }] },
      { rules: [{ match: {}, extra: 1 }] },
      { rules: [{ match: { class: 'quantum' } }] },
      { rules: [{ match: { tool: 3 } }] },
      { rules: [{ match: {}, report: 'yes' }] },
      { rules: [{ match: {}, input: 'x' }] },
      { rules: [{ match: {}, input: [''] }] },
      { rules: [{ match: {}, input: [1] }] },
    ];
    for (const params of bad) {
      const r = parseToolObserveParams(params);
      assert.equal(r.ok, false, JSON.stringify(params));
    }
  });

  test('limits report which limit (§6.6)', () => {
    const many = Array.from({ length: TOOL_OBSERVE_LIMITS.rules + 1 }, () => ({ match: {} }));
    const r1 = parseToolObserveParams({ rules: many });
    assert.equal(r1.ok, false);
    assert.deepEqual(!r1.ok && r1.data, { limit: 'rules' });
    const long = 'x'.repeat(TOOL_OBSERVE_LIMITS.stringLength + 1);
    const r2 = parseToolObserveParams({ rules: [{ match: { tool: long } }] });
    assert.deepEqual(!r2.ok && r2.data, { limit: 'stringLength' });
    const paths = Array.from({ length: TOOL_OBSERVE_LIMITS.pathsPerRule + 1 }, (_, i) => `f${i}`);
    const r3 = parseToolObserveParams({ rules: [{ match: {}, input: paths }] });
    assert.deepEqual(!r3.ok && r3.data, { limit: 'pathsPerRule' });
    // The floor the RFC asks for is accepted.
    assert.equal(parseToolObserveParams({ rules: Array.from({ length: 64 }, () => ({ match: {} })) }).ok, true);
  });
});

// ── RFC §6.3 field paths, §5.2 bounds ───────────────────────────────────────

describe('field selection and bounding', () => {
  test('nested path keeps structure; whole object/array; missing selects nothing', () => {
    const input = { target: { window_id: 3, kind: 'w' }, x: 1, list: [1, 2], s: 'str' };
    assert.deepEqual(selectFields(input, ['target.window_id']), { target: { window_id: 3 } });
    assert.deepEqual(selectFields(input, ['target', 'list']), { target: { window_id: 3, kind: 'w' }, list: [1, 2] });
    assert.deepEqual(selectFields(input, ['z']), {});
    assert.deepEqual(selectFields(input, ['s.length']), {}); // through a non-object
    assert.deepEqual(selectFields(input, ['target.window_id', 'target']), { target: { window_id: 3, kind: 'w' } });
  });

  test('field paths cannot reach or write prototypes', () => {
    const out = selectFields({ a: 1 }, ['__proto__.polluted', 'constructor', 'toString']);
    assert.deepEqual(out, {});
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  test('within bound → untouched', () => {
    const v = { a: 'x'.repeat(100) };
    assert.deepEqual(boundInput(v, 16 * 1024), { value: v, altered: false });
  });

  test('vector 15 — a 200 KiB argument is cut to fit, still an object, altered', () => {
    const big = { content: 'y'.repeat(200 * 1024), path: '/tmp/out.txt' };
    const r = boundInput(big, 16 * 1024)!;
    assert.ok(r.altered);
    assert.ok(Buffer.byteLength(JSON.stringify(r.value)) <= 16 * 1024);
    assert.equal(r.value.path, '/tmp/out.txt');
    assert.ok(typeof r.value.content === 'string' && big.content.startsWith(r.value.content as string));
  });

  test('many small members: dropped until it fits', () => {
    const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]));
    const r = boundInput(wide, 2048)!;
    assert.ok(r.altered);
    assert.ok(Buffer.byteLength(JSON.stringify(r.value)) <= 2048);
  });

  test('configured bound applies after selection; selection alone never sets inputAltered', () => {
    const o = observer('obs', [OBSERVE, INPUTS], rules([{ match: {}, input: ['content'] }]));
    const writeCall = call({ tool: 'files--write', class: ['files'], input: { content: 'z'.repeat(5000), path: '/p' } });
    const tight = openingFor(o, { ...DEFAULT_INPUTS, maxInputBytes: 1024 }, writeCall, 'started')!;
    assert.equal(tight.inputAltered, true);
    assert.ok(Buffer.byteLength(JSON.stringify(tight.input)) <= 1024);
    const loose = openingFor(o, DEFAULT_INPUTS, writeCall, 'started')!;
    assert.equal(loose.inputAltered, undefined);
    assert.deepEqual(Object.keys(loose.input!), ['content']);
  });
});

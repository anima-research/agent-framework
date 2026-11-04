/**
 * suppression_stats' counting (gate/suppression-stats.ts), over rows as a
 * message slot holds them, and the admission stage's suppressed disposition.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderSuppressedDump, suppressedRecords, suppressionStats, suppressionRecordOf, SUPPRESSION_PREVIEW_CHARS, type SuppressionStatsRow,
} from '../src/gate/suppression-stats.js';
import { admit, type AdmissionPolicy, type InboundEnvelope } from '../src/admission/admit.js';

const T0 = Date.parse('2026-11-02T10:00:00Z');
let n = 0;
const row = (text: string, at: number, metadata: Record<string, unknown> = {}): SuppressionStatsRow => ({
  id: `m${++n}`, timestamp: new Date(at), content: [{ type: 'text', text }], metadata,
});
const hidden = (rule: string, text: string, at: number, more: Record<string, unknown> = {}) =>
  row(text, at, { serverId: 'body', suppressed: { rule, eventType: 'mcpl:push-event' }, ...more });

describe('suppressionStats', () => {
  it('counts each rule\'s rows, their text, when they arrived, and where from, newest shown first', () => {
    const rows = [
      row('a visible message', T0),
      hidden('hide-eye', 'eye off', T0 + 1000),
      hidden('hide-eye', 'eye on', T0 + 2000, { channelId: 'body:eye' }),
      hidden('hide-ears', 'speaker 2: ha ha', T0 + 3000, { serverId: 'room', author: { name: 'speaker 2' } }),
      hidden('hide-eye', 'eye off again', T0 + 4000),
    ];
    const stats = suppressionStats(rows, [{ name: 'hide-eye', sinceStart: 2 }, { name: 'hide-ears', sinceStart: 1 }], { recent: 2 });
    assert.equal(stats.total, 4);
    assert.equal(stats.totalCharacters, 'eye off'.length + 'eye on'.length + 'speaker 2: ha ha'.length + 'eye off again'.length);
    const [eye, ears] = stats.rules;
    assert.equal(eye.rule, 'hide-eye');
    assert.equal(eye.inForce, true);
    assert.equal(eye.sinceStart, 2);
    assert.equal(eye.suppressed, 3);
    assert.equal(eye.first, new Date(T0 + 1000).toISOString());
    assert.equal(eye.last, new Date(T0 + 4000).toISOString());
    assert.deepEqual(eye.bySource, { body: 3 });
    assert.deepEqual(eye.byEventType, { 'mcpl:push-event': 3 });
    assert.deepEqual(eye.recent.map((r) => r.preview), ['eye off again', 'eye on'], 'newest first, as many as asked');
    assert.equal(eye.recent[1].channel, 'body:eye');
    assert.equal(ears.recent[0].author, 'speaker 2');
    assert.equal(ears.recent[0].source, 'room');
  });

  it('lists every rule in force, even one that has hidden nothing, and then removed rules, most recently active first', () => {
    const rows = [hidden('old-a', 'x', T0), hidden('old-b', 'y', T0 + 5000), hidden('old-a', 'z', T0 + 1000)];
    const stats = suppressionStats(rows, [{ name: 'fresh', sinceStart: 0 }]);
    assert.deepEqual(stats.rules.map((r) => [r.rule, r.inForce, r.suppressed]), [['fresh', true, 0], ['old-b', false, 1], ['old-a', false, 2]]);
    assert.equal(stats.rules[1].sinceStart, undefined, 'a removed rule has no count since start');
  });

  it('filters by rule and by time, and cuts a long preview to one line', () => {
    const long = `first line\n${'word '.repeat(80)}`;
    const rows = [hidden('r', 'early', T0), hidden('r', long, T0 + 10_000), hidden('s', 'other', T0 + 20_000)];
    const onlyR = suppressionStats(rows, [], { rule: 'r', sinceMs: T0 + 5000, recent: 5 });
    assert.deepEqual(onlyR.rules.map((r) => r.rule), ['r']);
    assert.equal(onlyR.rules[0].suppressed, 1);
    const preview = onlyR.rules[0].recent[0].preview;
    assert.ok(!preview.includes('\n'));
    assert.equal([...preview].length, SUPPRESSION_PREVIEW_CHARS);
    assert.ok(preview.endsWith('…'));
    assert.deepEqual(suppressionStats(rows, [], { recent: 0 }).rules.map((r) => r.recent.length), [0, 0]);
    assert.equal(suppressionStats(rows, [], { recent: 500 }).rules.find((r) => r.rule === 'r')!.recent.length, 2, 'at most what there is');
  });

  it('reads only the framework\'s record: a row without a rule name is no suppressed row', () => {
    assert.equal(suppressionRecordOf({ suppressed: true }), undefined);
    assert.equal(suppressionRecordOf({ suppressed: { eventType: 'x' } }), undefined);
    assert.deepEqual(suppressionRecordOf({ suppressed: { rule: 'r' } }), { rule: 'r' });
    const stats = suppressionStats([row('x', T0, { suppressed: 'yes' })], []);
    assert.equal(stats.total, 0);
  });

  it('puts sources past the tenth under "(others)"', () => {
    const rows = Array.from({ length: 12 }, (_, i) => hidden('r', 'x', T0 + i, { serverId: `s${i}` }));
    const bySource = suppressionStats(rows, []).rules[0].bySource;
    assert.equal(Object.keys(bySource).length, 11);
    assert.equal(bySource['(others)'], 2);
  });
});

describe('admit: suppression', () => {
  const env = (over: Partial<InboundEnvelope> = {}): InboundEnvelope => ({
    lane: 'push', serverId: 'body', channelId: 'eye', messageId: 'e1', addressed: false, vetoed: false,
    gateContent: 'eye off', gateMetadata: {}, ...over,
  });
  const policy = (rule: string | null, held = false) => {
    const calls = { evaluate: 0, probe: 0, holdFor: 0 };
    const p: AdmissionPolicy = {
      untargetedRecipients: () => ['mira'],
      holdFor: (serverId, channelId) => { calls.holdFor++; return held ? { kind: 'tune-out', epochId: 'e', serverId, channelId } : null; },
      gate: {
        evaluate: () => { calls.evaluate++; return true; },
        probe: () => { calls.probe++; return true; },
      },
      suppressionFor: () => rule,
    };
    return { p, calls };
  };

  it('a suppressed event is decided first: not held, not shown to the gate, no wake, no locus', () => {
    const { p, calls } = policy('hide-eye', true);
    const d = admit(env(), p);
    assert.deepEqual(d.suppressed, { rule: 'hide-eye' });
    assert.equal(d.held, null);
    assert.equal(d.wake, false);
    assert.equal(d.locus, false);
    assert.equal(d.gatePass, false);
    assert.deepEqual(calls, { evaluate: 0, probe: 0, holdFor: 0 });
  });

  it('an event no suppress rule takes is decided as before', () => {
    const { p, calls } = policy(null);
    const d = admit(env(), p);
    assert.equal(d.suppressed, null);
    assert.equal(d.wake, true);
    assert.deepEqual(calls, { evaluate: 1, probe: 0, holdFor: 1 });
    const vetoed = admit(env({ vetoed: true }), policy(null).p);
    assert.equal(vetoed.suppressed, null);
    assert.equal(vetoed.wake, false);
  });

  it('a vetoed event is still suppressed: its row is stored all the same', () => {
    const d = admit(env({ vetoed: true }), policy('hide-eye').p);
    assert.deepEqual(d.suppressed, { rule: 'hide-eye' });
  });
});


describe('suppressedRecords and renderSuppressedDump', () => {
  const rows = [
    row('visible', T0),
    hidden('r', 'first hidden', T0 + 1000, { channelId: 'c', author: { name: 'ann' } }),
    { id: 'img', timestamp: new Date(T0 + 2000), content: [{ type: 'text', text: 'look' }, { type: 'image' }], metadata: { serverId: 'body', suppressed: { rule: 's', eventType: 'mcpl:push-event' } } },
    hidden('r', 'third hidden', T0 + 3000),
  ];

  it('gives the suppressed rows whole, oldest first, filtered by rule and time, naming non-text blocks', () => {
    const all = suppressedRecords(rows);
    assert.deepEqual(all.map((r) => r.text), ['first hidden', 'look\n[image]', 'third hidden']);
    assert.deepEqual(all[0], {
      id: all[0].id, at: new Date(T0 + 1000).toISOString(), rule: 'r', eventType: 'mcpl:push-event', source: 'body', channel: 'c', author: 'ann', text: 'first hidden',
    });
    assert.deepEqual(suppressedRecords(rows, { rule: 'r', sinceMs: T0 + 2000 }).map((r) => r.text), ['third hidden']);
    assert.deepEqual(suppressedRecords(rows, { untilMs: T0 + 2000 }).map((r) => r.text), ['first hidden']);
  });

  it('writes a transcript or JSON lines, keeping the newest that fit and counting the rest', () => {
    const records = suppressedRecords(rows);
    const text = renderSuppressedDump(records, 'text', { maxBytes: 1_000_000, title: 'Suppressed events' });
    assert.equal(text.written, 3);
    assert.match(text.content, /^# Suppressed events\n\n\[.+\] r · mcpl:push-event · body · c · ann · m\d+\nfirst hidden\n\n/);
    const jsonl = renderSuppressedDump(records, 'jsonl', { maxBytes: 1_000_000, title: 'x' });
    assert.deepEqual(jsonl.content.trim().split('\n').map((l) => JSON.parse(l).text), ['first hidden', 'look\n[image]', 'third hidden']);
    const oneLine = Buffer.byteLength(`${JSON.stringify(records[2])}\n`);
    const cut = renderSuppressedDump(records, 'jsonl', { maxBytes: oneLine + 5, title: 'x' });
    assert.deepEqual([cut.written, cut.omitted], [1, 2]);
    assert.equal(JSON.parse(cut.content).text, 'third hidden', 'the newest is kept');
    const cutText = renderSuppressedDump(records, 'text', { maxBytes: 200, title: 'Suppressed events' });
    assert.match(cutText.content, /older events left out to fit/);
  });
});

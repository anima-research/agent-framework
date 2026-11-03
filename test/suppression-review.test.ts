/**
 * The periodic review of what suppress rules hid (gate/suppression-review.ts):
 * what the reviewer is asked, how its answer is read, what the agent is told
 * and when, and what's kept between reviews.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Membrane, NormalizedRequest } from '@animalabs/membrane';
import {
  SuppressionReview, parseReviewAnswer, reviewNoticeText, reviewSettings, spread,
  DEFAULT_REVIEW_INTERVAL_MS, MIN_REVIEW_INTERVAL_MS, type ReviewRuleInfo, type SuppressionReviewDeps,
} from '../src/gate/suppression-review.js';
import type { SuppressedEventRecord } from '../src/gate/suppression-stats.js';
import type { SuppressionReviewOptions } from '../src/gate/types.js';

const T0 = Date.parse('2026-11-03T04:00:00Z');
const HOUR = 3_600_000;
const rec = (rule: string, i: number, text: string, at = T0 + i * 1000): SuppressedEventRecord => ({
  id: `m${rule}${i}`, at: new Date(at).toISOString(), rule, eventType: 'mcpl:push-event', source: 'room', text,
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'suppression-review-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(opts: {
  records?: SuppressedEventRecord[];
  rules?: ReviewRuleInfo[];
  answers?: Array<string | Error>;
  options?: SuppressionReviewOptions;
  statePath?: string | null;
  start?: number;
} = {}) {
  // Made at `start` (T0 by default): a first review covers what was hidden since.
  let now = opts.start ?? T0;
  const requests: NormalizedRequest[] = [];
  const delivered: Array<{ text: string; wake: boolean }> = [];
  const traces: Array<Record<string, unknown>> = [];
  const answers = [...(opts.answers ?? [])];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      requests.push(request);
      const next = answers.shift() ?? '{"fits": true, "flagged": [], "note": "all ambient"}';
      if (next instanceof Error) throw next;
      return { content: [{ type: 'text', text: next }], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 10 } };
    },
  } as unknown as Membrane;
  let records = opts.records ?? [];
  const deps: SuppressionReviewDeps = {
    agentName: () => 'agent',
    membraneFor: () => membrane,
    records: (_agent, since, until) => records.filter((r) => Date.parse(r.at) >= since && Date.parse(r.at) < until),
    rules: () => opts.rules ?? [{ name: 'hide-ears', description: 'ambient chatter from the room', match: { source: 'room' } }],
    deliver: (_agent, text, wake) => { delivered.push({ text, wake }); },
    emitTrace: (t) => { traces.push(t as Record<string, unknown>); },
    ...(opts.statePath === null ? {} : { statePath: opts.statePath ?? join(dir, 'suppression-review.json') }),
    now: () => now,
  };
  const review = new SuppressionReview(deps, opts.options);
  return {
    review, requests, delivered, traces,
    /** Run a review at `t` (two hours after T0 by default). */
    run: (t = T0 + 2 * HOUR) => { now = t; return review.runOnce(); },
    setNow: (t: number) => { now = t; },
    setRecords: (r: SuppressedEventRecord[]) => { records = r; },
  };
}

describe('the review\'s settings and helpers', () => {
  it('defaults to every two hours on Haiku 5.5, and keeps the interval to at least ten minutes', () => {
    const s = reviewSettings();
    assert.equal(s.intervalMs, DEFAULT_REVIEW_INTERVAL_MS);
    assert.equal(s.model, 'claude-haiku-5-5');
    assert.equal(s.notify, 'always');
    assert.equal(s.wakeOnFlag, true);
    assert.equal(reviewSettings({ intervalMs: 1000 }).intervalMs, MIN_REVIEW_INTERVAL_MS);
  });

  it('spreads a sample across the whole period, first and last included', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const sample = spread(items, 5);
    assert.deepEqual(sample, [0, 25, 50, 74, 99]);
    assert.deepEqual(spread([1, 2], 5), [1, 2]);
  });

  it('reads the reviewer\'s JSON, with prose around it, keeping only numbers it was shown', () => {
    assert.deepEqual(parseReviewAnswer('Sure.\n{"fits": false, "flagged": [3, 3, 9, 0, "2"], "note": "a direct question"}\n', 5),
      { flagged: [3], note: 'a direct question' });
    assert.deepEqual(parseReviewAnswer('{"fits": true, "flagged": []}', 5), { flagged: [], note: '' });
    assert.equal(parseReviewAnswer('they all fit', 5), undefined);
    assert.equal(parseReviewAnswer('{"flagged": "3"}', 5), undefined);
  });
});

describe('a review', () => {
  it('asks the reviewer about each rule that hid events, against its description, and tells the agent', async () => {
    const records = [rec('hide-ears', 1, 'speaker 2: ha ha'), rec('hide-ears', 2, 'speaker 4: hey agent, can you check the oven timer?'), rec('hide-ears', 3, 'speaker 1: yeah')];
    const h = harness({ records, answers: ['{"fits": false, "flagged": [2], "note": "one line asks the agent a question"}'] });
    const summary = await h.run();
    assert.equal(h.requests.length, 1);
    const asked = JSON.stringify(h.requests[0]);
    assert.match(asked, /ambient chatter from the room/, 'the description');
    assert.match(asked, /\\"source\\":\\"room\\"/, 'the match');
    assert.match(asked, /#2 \[[^\]]+\] mcpl:push-event · room: speaker 4: hey agent, can you check/, 'the events, numbered');
    assert.equal(h.requests[0].config.model, 'claude-haiku-5-5');
    assert.equal(summary?.flagged, 1);
    assert.equal(h.delivered.length, 1);
    assert.equal(h.delivered[0].wake, true, 'a flagged event wakes the agent');
    const text = h.delivered[0].text;
    assert.match(text, /^\[suppression review\] Since 2026-11-03T04:00:00Z \(2 hours\), your suppress rules hid 3 events, and the reviewer flagged 1/);
    assert.match(text, /"hide-ears" \(ambient chatter from the room\) hid 3\. The reviewer read them and flagged 1: one line asks the agent a question/);
    assert.match(text, /· \[.+\] room: "speaker 4: hey agent, can you check the oven timer\?" \(id mhide-ears2\)/);
    assert.equal(h.traces[0].type, 'gate:suppression-review');
  });

  it('tells the agent without waking it when everything fit, and says nothing when nothing was hidden', async () => {
    const h = harness({ records: [rec('hide-ears', 1, 'chatter')] });
    await h.run();
    assert.equal(h.delivered.length, 1);
    assert.equal(h.delivered[0].wake, false);
    assert.match(h.delivered[0].text, /The reviewer read them and found they fit\./);
    h.setRecords([]);
    await h.run(T0 + 4 * HOUR);
    assert.equal(h.delivered.length, 1, 'no notice for a period with nothing hidden');
    assert.equal(h.requests.length, 1, 'and no call');
  });

  it('with notify "flagged", tells the agent only of a flag; wakeOnFlag false tells without waking', async () => {
    const quiet = harness({ records: [rec('hide-ears', 1, 'chatter')], options: { notify: 'flagged' } });
    await quiet.run();
    assert.equal(quiet.delivered.length, 0);
    const noWake = harness({ statePath: null, records: [rec('hide-ears', 1, 'hey agent?')], options: { wakeOnFlag: false }, answers: ['{"fits": false, "flagged": [1]}'] });
    await noWake.run();
    assert.equal(noWake.delivered[0].wake, false);
  });

  it('reads at most maxEventsPerRule events, spread across the period, and says how many it read', async () => {
    const records = Array.from({ length: 50 }, (_, i) => rec('hide-ears', i, `line ${i}`));
    const h = harness({ records, options: { maxEventsPerRule: 10 } });
    await h.run();
    const listing = (h.requests[0].messages[0].content[0] as { text: string }).text;
    assert.match(listing, /it hid 50 events\. Here are 10 of them, spread across that time:/);
    assert.match(listing, /#1 .*line 0\b/);
    assert.match(listing, /#10 .*line 49\b/);
    assert.ok(!listing.includes('#11 '));
    assert.match(h.delivered[0].text, /The reviewer read 10 of them and found they fit/);
  });

  it('reports a reviewer that fails or answers without a verdict, and goes on', async () => {
    const h = harness({
      records: [rec('a', 1, 'x'), rec('b', 2, 'y')],
      rules: [{ name: 'a', description: 'aa' }, { name: 'b', description: 'bb' }],
      answers: [new Error('overloaded'), 'I think they are fine'],
    });
    const summary = await h.run();
    assert.deepEqual(summary?.rules.map((r) => [r.rule, r.verdict]), [['a', 'error'], ['b', 'error']]);
    assert.match(h.delivered[0].text, /"a" \(aa\) hid 1\. The reviewer couldn't answer this time \(overloaded\)\./);
    assert.match(h.delivered[0].text, /"b" \(bb\) hid 1\. The reviewer couldn't answer this time \(its answer held no verdict/);
    assert.equal(h.delivered[0].wake, false, 'an error is no flag');
  });

  it('judges a removed rule\'s events against its last known description, and keeps where it reviewed through', async () => {
    const statePath = join(dir, 'suppression-review.json');
    const first = harness({ statePath, records: [rec('hide-ears', 1, 'chatter')] });
    await first.run();
    const saved = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.equal(saved.reviewedThrough, T0 + 2 * HOUR);
    assert.equal(saved.descriptions['hide-ears'], 'ambient chatter from the room');

    // A restart, the rule since removed, its later events still in the slot.
    const later = [rec('hide-ears', 1, 'old', T0 + HOUR), rec('hide-ears', 2, 'after restart', T0 + 3 * HOUR)];
    const second = harness({ statePath, records: later, rules: [], start: T0 + 4 * HOUR });
    assert.equal(second.review.nextReviewAfter, T0 + 4 * HOUR, 'it picks up from where the last review stopped');
    const summary = await second.run(T0 + 4 * HOUR);
    assert.equal(summary?.fromMs, T0 + 2 * HOUR);
    assert.deepEqual(summary?.rules.map((r) => [r.rule, r.suppressed, r.inForce, r.description]), [['hide-ears', 1, false, 'ambient chatter from the room']]);
    assert.match(second.delivered[0].text, /"hide-ears" \(ambient chatter from the room\), since removed, hid 1/);
  });

  it('a rule with no description known is reported unjudged, and no call is made for it', async () => {
    const h = harness({ statePath: null, records: [rec('mystery', 1, 'x')], rules: [] });
    const summary = await h.run();
    assert.equal(summary?.rules[0].verdict, 'unjudged');
    assert.equal(h.requests.length, 0);
    assert.match(h.delivered[0].text, /There was no description to judge them against/);
  });

  it('a notice that can\'t be written leaves the period to the next review', async () => {
    const statePath = join(dir, 'suppression-review.json');
    const h = harness({ statePath, records: [rec('hide-ears', 1, 'chatter')] });
    (h.review as unknown as { deps: SuppressionReviewDeps }).deps.deliver = () => { throw new Error('store refused'); };
    await assert.rejects(h.run(), /store refused/);
    assert.equal(existsSync(statePath), false, 'nothing recorded as reviewed');
  });

  it('notices name every rule, and the text stays one notice', () => {
    const text = reviewNoticeText({
      fromMs: T0, toMs: T0 + 2 * HOUR, total: 7, flagged: 6,
      rules: [{ rule: 'r', description: 'd', inForce: true, suppressed: 7, read: 7, verdict: 'flagged', flagged: Array.from({ length: 6 }, (_, i) => rec('r', i, `x${i}`)) }],
    });
    assert.match(text, /· and 1 more/);
    assert.match(text, /suppression_stats and dump_suppressed show what a rule hid/);
  });

  it('a review the host stops while the reviewer is asked tells nothing and records nothing', async () => {
    const statePath = join(dir, 'suppression-review.json');
    let release: () => void = () => {};
    const h = harness({ statePath, records: [rec('hide-ears', 1, 'chatter')] });
    (h.review as unknown as { deps: SuppressionReviewDeps }).deps.membraneFor = () => ({
      complete: () => new Promise((resolve) => { release = () => resolve({ content: [{ type: 'text', text: '{"fits": true, "flagged": []}' }], stopReason: 'end_turn' }); }),
    }) as unknown as Membrane;
    const running = h.run();
    await new Promise((resolve) => setImmediate(resolve));
    h.review.stop();
    release();
    assert.equal(await running, null);
    assert.equal(h.delivered.length, 0);
    assert.equal(existsSync(statePath), false);
  });
});

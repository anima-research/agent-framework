// A render describes what changed since the server's previous render (RFC-006
// §5.2), so a later render can't replace an earlier one still unread: the
// earlier one stays where it was placed, the later one lands after it, and a
// retraction or a plain occurrence takes the whole run, newest first (§3.3,
// vector 49; §6). #548 found the second render taking the subject's one slot
// over the first; a notice between two renders dropped the first as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PushCoalescer, type CoalescerHost, type CoalescedOccurrence, type CoalescingSnapshot } from '../src/mcpl/push-coalescer.js';
import { TS } from './helpers/coalescing-fixture.js';

interface Options {
  /** Placements the host fails to remove (CoalescerHost.remove returns false). */
  unremovable?: Set<string>;
}

/** A host whose every delivery is stored for 'other', an agent whose turn is
 *  alive, and not presented to it (#291), where it waits unread until it's
 *  removed, read, or gone, whichever agent assembled it. CoalescerHost leaves
 *  placement to the host, so this is one it allows; the framework presents
 *  the assembling agent's own render before its turn's compile, which
 *  mcpl-coalescing's tests run. Its removal, like the framework's, doesn't
 *  refuse a message a request has read. Each render says which notices it
 *  covers, as a notice-only server's does. (Before #291 such a delivery
 *  waited in the framework's deferred queue, under a `deferredId`.) */
function makeHost(options: Options = {}) {
  const queue: Array<{ id: string; text: string }> = [];
  const read = new Set<string>();
  const removed: string[] = [];
  const audits: string[] = [];
  const wakes: string[] = [];
  const deliveries: Array<{ eventId: string; deliverTo?: string }> = [];
  const held = new Map<string, () => void>();
  const hold = { n1: false };
  let renderStarted: (eventId: string) => void = () => {};
  let saved: () => CoalescingSnapshot = () => { throw new Error('nothing saved'); };
  const host: CoalescerHost<null> = {
    isUnread: (placement) => queue.some((m) => m.id === placement.messageId) && !read.has(placement.messageId ?? ''),
    // Nothing here shows a render without a request reading it.
    isUnshown: (placement) => queue.some((m) => m.id === placement.messageId) && !read.has(placement.messageId ?? ''),
    remove: (placement) => {
      const id = placement.messageId ?? '';
      if (options.unremovable?.has(id)) return false;
      const at = queue.findIndex((m) => m.id === id);
      if (at < 0) return false;
      queue.splice(at, 1);
      removed.push(id);
      return true;
    },
    deliver: async (occurrence, materialized) => {
      const id = `row-${deliveries.length + 1}`;
      deliveries.push({ eventId: occurrence.eventId, deliverTo: occurrence.deliverTo });
      queue.push({ id, text: (materialized ?? occurrence.content).map((block) => (block.type === 'text' ? block.text : '')).join('') });
      return { agent: occurrence.deliverTo ?? 'other', messageId: id, presented: false };
    },
    wakeForBatch: async (occurrence) => { wakes.push(`${occurrence.eventId}>${occurrence.deliverTo ?? 'routing'}`); },
    wakeToRead: async () => {}, cancelWake: () => {}, authorized: () => true,
    audience: async (occurrence) => (occurrence.deliverTo ? [occurrence.deliverTo] : ['agent', 'other']),
    render: async (occurrence, params) => {
      renderStarted(occurrence.eventId);
      await new Promise<void>((resolve) => { if (occurrence.eventId === 'n1' && hold.n1) held.set('n1', resolve); else resolve(); });
      return { content: [{ type: 'text', text: `changes in ${params.notices.map((notice) => notice.eventId).join(', ')}` }] };
    },
    audit: (record) => {
      if (['removed', 'displaced', 'remove-failed'].includes(String(record.kind))) audits.push(`${String(record.kind)}:${String(record.eventId)}`);
    },
    save: (snapshot) => { saved = snapshot; },
  };
  return {
    host, queue, read, removed, audits, wakes, deliveries, hold,
    snapshot: () => saved(),
    texts: () => queue.map((m) => m.text),
    started: () => new Promise<string>((resolve) => { renderStarted = resolve; }),
    release: (eventId: string) => held.get(eventId)?.(),
    /** A message gone from the queue without the coalescer, as a module's removal takes one. */
    gone: (id: string) => { queue.splice(queue.findIndex((m) => m.id === id), 1); },
  };
}

const occurrence = (eventId: string, flags: Partial<CoalescedOccurrence<null>> = {}): CoalescedOccurrence<null> => ({
  serverId: 'editor', binding: 'binding', scope: { kind: 'featureSet', id: 'doc' }, key: 'document', eventId, timestamp: TS,
  retract: false, deferred: false, initial: false, content: [{ type: 'text', text: eventId }], event: null, ...flags,
});
const notice = (eventId: string, initial = false) => occurrence(eventId, { deferred: true, initial });
const retraction = (text?: string) => occurrence('r1', { retract: true, content: text ? [{ type: 'text', text }] : [] });

/** #548's sequence: n1's batch renders for 'agent'; n2 arrives during that
 *  render and opens a batch of its own (§5.4 rule 1); n1's render lands
 *  unread in 'other''s queue, and n2's batch then follows 'other'; 'other''s
 *  next assembly renders it. */
async function renderAfterRender(h: ReturnType<typeof makeHost>, coalescer: PushCoalescer<null>): Promise<void> {
  h.hold.n1 = true;
  await coalescer.accept(notice('n1', true));
  const started = h.started();
  const first = coalescer.assemble('agent');
  await started;
  await coalescer.accept(notice('n2'));
  h.release('n1');
  await first;
  await coalescer.assemble('other');
}

/** Three renders, each settling unread in 'other''s queue after a notice. */
async function threeRenders(coalescer: PushCoalescer<null>): Promise<void> {
  await coalescer.accept(notice('n1', true));
  await coalescer.assemble('agent');
  await coalescer.accept(notice('n2'));
  await coalescer.assemble('other');
  await coalescer.accept(notice('n3'));
  await coalescer.assemble('other');
}

test("a render settling while an earlier render is unread lands after it, and a retraction removes both, newest first (#548)", async () => {
  const h = makeHost();
  const coalescer = new PushCoalescer<null>(h.host);
  await renderAfterRender(h, coalescer);
  assert.deepEqual(h.texts(), ['changes in n1', 'changes in n2'], "n1's render stays, and n2's lands after it");
  const result = await coalescer.accept(retraction());
  assert.deepEqual(h.removed, ['row-2', 'row-1'], 'the retraction removes the run, newest first');
  assert.deepEqual(h.audits, ['removed:n2', 'removed:n1']);
  assert.deepEqual(h.texts(), []);
  assert.equal(result.coalesce?.outcome, 'retracted', 'nothing of the subject was read');
});

test("a batch opened while a render was under way follows the run's agent once that render lands unread", async () => {
  const h = makeHost();
  const coalescer = new PushCoalescer<null>(h.host);
  h.hold.n1 = true;
  await coalescer.accept(notice('n1', true));
  const started = h.started();
  const first = coalescer.assemble('agent');
  await started;
  await coalescer.accept(notice('n2'));
  h.release('n1');
  await first;
  assert.equal(h.wakes.at(-1), 'n2>other', "n2's batch's wakes follow it to 'other'");
  await coalescer.assemble('agent');
  assert.deepEqual(h.texts(), ['changes in n1'], "'agent' isn't in n2's batch's audience any more, so its assembly renders nothing");
  await coalescer.assemble('other');
  assert.deepEqual(h.texts(), ['changes in n1', 'changes in n2'], "'other''s assembly renders it, after the render it builds on");
  assert.equal(h.deliveries.at(-1)?.deliverTo, 'other');
});

test("a notice after a render still unread leaves it in place, and its batch renders in that render's agent, after it", async () => {
  const h = makeHost();
  const coalescer = new PushCoalescer<null>(h.host);
  await coalescer.accept(notice('n1', true));
  await coalescer.assemble('agent');
  assert.deepEqual(h.texts(), ['changes in n1']);
  const result = await coalescer.accept(notice('n2'));
  assert.equal(result.coalesce?.outcome, 'first', 'the notice opens a batch, displacing nothing');
  assert.equal(result.coalesce?.priorEventId, undefined, "n1's render was neither displaced nor found consumed, and nothing else of the subject was");
  assert.deepEqual(h.texts(), ['changes in n1'], "n1's render stays unread");
  assert.equal(h.wakes.at(-1), 'n2>other', 'the batch follows the agent whose context holds the run');
  await coalescer.assemble('other');
  assert.deepEqual(h.texts(), ['changes in n1', 'changes in n2'], "n2's render lands after the render it builds on");
  const withdrawn = await coalescer.accept(retraction());
  assert.deepEqual(h.removed, ['row-2', 'row-1']);
  assert.equal(withdrawn.coalesce?.outcome, 'retracted');
});

test('a notice over an unread render names, as its prior, an earlier render a request has read', async () => {
  const h = makeHost();
  const coalescer = new PushCoalescer<null>(h.host);
  await renderAfterRender(h, coalescer);
  h.read.add('row-1');
  const result = await coalescer.accept(notice('n3'));
  assert.equal(result.coalesce?.priorEventId, 'n1', "n1's render was found consumed; n2's, still unread, isn't the prior");
  assert.deepEqual(h.removed, [], "n2's render stays");
});

test("a plain occurrence displaces the whole run, newest first, and takes its place in the run's agent", async () => {
  const h = makeHost();
  const coalescer = new PushCoalescer<null>(h.host);
  await renderAfterRender(h, coalescer);
  const result = await coalescer.accept(occurrence('p1'));
  assert.equal(result.coalesce?.outcome, 'replaced');
  assert.equal(result.coalesce?.priorEventId, 'n2');
  assert.deepEqual(h.removed, ['row-2', 'row-1'], 'a complete snapshot supersedes every render');
  assert.deepEqual(h.audits, ['displaced:n2', 'displaced:n1']);
  assert.deepEqual(h.texts(), ['p1']);
  assert.equal(h.deliveries.at(-1)?.deliverTo, 'other', 'it goes where the run was (§3.2)');
});

test("a plain occurrence over a run whose newest render can't be removed is appended, as after a consumed version", async () => {
  const h = makeHost({ unremovable: new Set(['row-2']) });
  const coalescer = new PushCoalescer<null>(h.host);
  await renderAfterRender(h, coalescer);
  const result = await coalescer.accept(occurrence('p1'));
  assert.equal(result.coalesce?.outcome, 'appended');
  assert.deepEqual(h.audits, ['displaced:n2', 'remove-failed:n2']);
  assert.deepEqual(h.removed, [], "n1's render stays as the baseline of n2's, which may be read");
  assert.deepEqual(h.texts(), ['changes in n1', 'changes in n2', 'p1']);
  assert.equal(h.deliveries.at(-1)?.deliverTo, undefined, 'appended as a fresh occurrence');
});

test("a retraction stops at a render it can't remove, so that render keeps the renders it builds on, and the notice follows", async () => {
  const h = makeHost({ unremovable: new Set(['row-2']) });
  const coalescer = new PushCoalescer<null>(h.host);
  await renderAfterRender(h, coalescer);
  const result = await coalescer.accept(retraction('n1 and n2 withdrawn'));
  assert.deepEqual(h.removed, [], "n1's render stays as n2's baseline");
  assert.deepEqual(h.texts(), ['changes in n1', 'changes in n2', 'n1 and n2 withdrawn']);
  assert.equal(result.coalesce?.outcome, 'noted');
});

test("a retraction that can't remove an earlier render of the run appends its notice", async () => {
  const h = makeHost({ unremovable: new Set(['row-1']) });
  const coalescer = new PushCoalescer<null>(h.host);
  await renderAfterRender(h, coalescer);
  const result = await coalescer.accept(retraction('withdrawn'));
  assert.deepEqual(h.removed, ['row-2']);
  assert.deepEqual(h.audits, ['removed:n2', 'removed:n1', 'remove-failed:n1']);
  assert.deepEqual(h.texts(), ['changes in n1', 'withdrawn']);
  assert.equal(result.coalesce?.outcome, 'noted', "n1's render may be read, so the notice follows it");
});

test('an earlier render of the run that a request read is history: a retraction removes only what is unread, and appends its notice', async () => {
  const h = makeHost();
  const coalescer = new PushCoalescer<null>(h.host);
  await renderAfterRender(h, coalescer);
  h.read.add('row-1');
  const result = await coalescer.accept(retraction('withdrawn'));
  assert.deepEqual(h.removed, ['row-2'], 'the render the model read stays');
  assert.deepEqual(h.texts(), ['changes in n1', 'withdrawn']);
  assert.equal(result.coalesce?.outcome, 'noted');
});

test('a run of three renders stays in placement order, and a retraction removes it newest first', async () => {
  const h = makeHost();
  const coalescer = new PushCoalescer<null>(h.host);
  await threeRenders(coalescer);
  assert.deepEqual(h.texts(), ['changes in n1', 'changes in n2', 'changes in n3']);
  const stored = h.snapshot().subjects.find((s) => s.occupant)?.occupant;
  assert.deepEqual(stored, { eventId: 'n3', placement: { agent: 'other', messageId: 'row-3', presented: false } }, 'a snapshot keeps the occupant as restore() reads it, without its run');
  const result = await coalescer.accept(retraction());
  assert.deepEqual(h.removed, ['row-3', 'row-2', 'row-1']);
  assert.equal(result.coalesce?.outcome, 'retracted');
});

test("a render of the run that's gone without the coalescer leaves the rest of the run tracked", async () => {
  const h = makeHost();
  const coalescer = new PushCoalescer<null>(h.host);
  await threeRenders(coalescer);
  h.gone('row-2');
  const result = await coalescer.accept(retraction('withdrawn'));
  assert.deepEqual(h.removed, ['row-3', 'row-1'], 'the renders around the gone one are still removed');
  assert.deepEqual(h.texts(), ['withdrawn']);
  assert.equal(result.coalesce?.outcome, 'noted', 'a gone render may have been read');
});

test("a render left unread after a later one was read stays a render: a notice leaves it in place", async () => {
  const h = makeHost();
  const coalescer = new PushCoalescer<null>(h.host);
  await renderAfterRender(h, coalescer);
  h.read.add('row-2');
  const result = await coalescer.accept(notice('n3'));
  assert.equal(result.coalesce?.outcome, 'first');
  assert.deepEqual(h.removed, [], "n1's render, still unread, isn't displaced as if it were a plain occurrence");
  assert.deepEqual(h.texts(), ['changes in n1', 'changes in n2']);
  const withdrawn = await coalescer.accept(retraction('withdrawn'));
  assert.deepEqual(h.removed, ['row-1'], "n1's render is still tracked, so the retraction removes it");
  assert.equal(withdrawn.coalesce?.outcome, 'noted', "n2's render was read");
});

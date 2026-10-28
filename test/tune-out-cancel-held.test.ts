/**
 * What a tune-out's cancel makes of the messages it held. The dump and the
 * subconscious's report notice take the ended epoch's messages only, and the
 * notice counts what the dump left out. Every held message is stored as it
 * arrives (#291), so the subconscious's view holds each of them, its media
 * included, and none follows the notice as a row of its own (before #291 the
 * ones still queued at the cancel did). A cancel the subconscious makes
 * itself gets that notice and a report turn when some of the epoch's messages
 * came in after it last looked (unseenBySubconscious), or when it wrote no
 * note and the dump left anything out. Here the cap does it;
 * test/tune-out-dump-fit has the residents' per-message room do it too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';

interface Row { participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> }
interface Added { participant: string; content: ContentBlock[]; metadata?: Record<string, unknown>; forAgent?: string }

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const IMAGE = { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo=', mediaType: 'image/png' } } as ContentBlock;
const row = (author: string, content: ContentBlock[], epochId?: string): Row =>
  ({ participant: 'user', content, metadata: { author: { name: author }, ...(epochId ? { tuneOut: { epochId } } : {}) } });
const textOf = (content: ContentBlock[]): string =>
  content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');

/** Cancels epoch eA of disc:guild:a with the given cap and source, over the
 *  given stored messages, of which the subconscious hasn't seen `unseen`,
 *  and those a surgery's hold keeps in memory (`kept`), and returns what the
 *  coordinator added and whose inference it requested. */
function cancelWith(opts: { backlogCap: number; source: string; stored: Row[]; kept?: Row[]; unseen?: number; note?: string }) {
  const added: Added[] = [];
  const inferences: string[] = [];
  const registry = {
    // Each channel's id is unique here, so it's shown by its id.
    nameShown: (channel: { channelId: string }) => channel.channelId,
    quotedShown: (channel: { channelId: string }) => JSON.stringify(channel.channelId),
    cancelTuneOut: () => ({
      params: { epochId: 'eA', cadenceSeconds: 300, backlogCap: opts.backlogCap, maxWakes: 3, startedAtSequence: 0 },
      wakeCount: 0,
    }),
  };
  const hooks = {
    addMessage: (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, forAgent?: string) => {
      added.push({ participant, content, metadata, forAgent });
    },
    requestInference: (agentName: string) => { inferences.push(agentName); },
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => opts.stored,
    getSurgeryHeldMessages: () => opts.kept ?? [],
    unseenBySubconscious: () => opts.unseen ?? 0,
    emitTrace: () => {},
  };
  const coordinator = new TuneOutCoordinator(registry as never, {} as never, hooks as never);
  assert.deepEqual(coordinator.cancel('disc', 'disc:guild:a', opts.source, 'test', opts.note), { ok: true });
  const dump = added.find((m) => m.metadata?.kind === 'tune-out-cancel');
  assert.ok(dump, 'the cancel adds its dump');
  const notice = added.find((m) => m.metadata?.kind === 'tune-out-cancel-report');
  if (notice) assert.equal(notice.forAgent, 'Subconscious', 'the notice is for the subconscious');
  assert.deepEqual(added.filter((m) => m.metadata?.kind === 'tune-out-cancel-held'), [], 'no message follows the notice as a row of its own');
  return { dump: textOf(dump.content), notice, inferences };
}

const OTHERS = [row('Bo', [text('B1 stored')], 'eB'), row('Cy', [text('P plain')])];

test("a cancel's dump shows only its own epoch's messages, and its notice tells the report of nothing more when the dump shows them all", () => {
  const { dump, notice, inferences } = cancelWith({
    backlogCap: 10,
    source: 'agent-tool',
    stored: [row('Ann', [text('A1 stored')], 'eA'), row('Ann', [text('A2 stored during a turn')], 'eA'), ...OTHERS],
  });
  assert.ok(dump.includes('messages=2') && !dump.includes('truncated='), "the backlog is epoch eA's two messages, both shown");
  assert.ok(dump.includes('Ann: A1 stored') && dump.includes('Ann: A2 stored during a turn'), 'the dump shows them');
  for (const other of ['B1 stored', 'P plain']) assert.ok(!dump.includes(other), `and no "${other}"`);
  assert.ok(notice, 'the report gets its notice');
  assert.ok(!textOf(notice.content).includes("weren't delivered raw"), 'with no count of messages left out, as none is');
  assert.ok(!textOf(notice.content).includes('Still held'), 'and nothing said to be still held');
  assert.ok(inferences.includes('Subconscious'), 'and a report turn is requested');
});

test("the notice counts what the cap leaves out, which the subconscious's view holds stored, media and all", () => {
  const { dump, notice } = cancelWith({
    backlogCap: 0,
    source: 'agent-tool',
    stored: [row('Ann', [text('A1 stored')], 'eA'), row('Ann', [IMAGE], 'eA'), row('Bo', [text('A3 stored')], 'eA'), ...OTHERS],
  });
  assert.ok(dump.includes('messages=3 truncated=3'), "the backlog is epoch eA's three messages, all above the cap");
  assert.ok(notice, 'the report gets its notice');
  const noticeText = textOf(notice.content);
  assert.ok(noticeText.includes("3 of 3 diverted messages, the oldest, weren't delivered raw to the resident"), 'it gives the count');
  assert.ok(!noticeText.includes('after this one'), 'and hands on no row of its own');
});

test('a cancel the subconscious makes itself gets the notice and a report turn when messages came in it hasn\'t seen', () => {
  const unseen = cancelWith({ backlogCap: 10, source: 'subconscious', stored: [row('Ann', [text('A2 stored')], 'eA')], unseen: 1, note: 'Look.' });
  assert.ok(unseen.notice, 'a message it hasn\'t seen brings the notice');
  assert.ok(textOf(unseen.notice.content).includes('One of its held messages came in after you last looked; your view has it now.'),
    textOf(unseen.notice.content));
  assert.ok(unseen.inferences.includes('Subconscious'), 'and a report turn');

  const twoUnseen = cancelWith({ backlogCap: 0, source: 'subconscious', stored: [row('Ann', [text('A1')], 'eA'), row('Ann', [text('A2')], 'eA')], unseen: 2, note: 'Look.' });
  assert.ok(twoUnseen.notice && textOf(twoUnseen.notice.content).includes('2 of its held messages came in after you last looked; your view has them now.'));

  const allSeen = cancelWith({ backlogCap: 10, source: 'subconscious', stored: [row('Ann', [text('A2 stored')], 'eA')], note: 'Look.' });
  assert.ok(allSeen.dump.includes('A2 stored'), 'the dump shows the message');
  assert.equal(allSeen.notice, undefined, 'it saw everything it held, so it gets no notice');
  assert.ok(!allSeen.inferences.includes('Subconscious'), 'and no report turn');
});

test('a cancel the subconscious makes itself with no note gets the notice and a report turn when the cap cut stored messages', () => {
  const twoStored = [row('Ann', [text('S1 stored')], 'eA'), row('Ann', [text('S2 stored')], 'eA')];
  const storedCut = cancelWith({ backlogCap: 0, source: 'subconscious', stored: twoStored });
  assert.ok(storedCut.dump.includes('messages=2 truncated=2'), 'at backlogCap 0 the dump counts both stored messages');
  assert.ok(!storedCut.dump.includes('S1 stored') && !storedCut.dump.includes('S2 stored'), 'and shows neither');
  assert.ok(storedCut.notice, 'with no note, nothing else covers them, so the notice comes');
  assert.ok(textOf(storedCut.notice.content).includes('2 of 2 diverted messages, the oldest,'), 'with the count');
  assert.ok(!textOf(storedCut.notice.content).includes('Still held'), 'and nothing said to be still held');
  assert.ok(storedCut.inferences.includes('Subconscious'), 'and a report turn');

  const storedCutNoted = cancelWith({ backlogCap: 0, source: 'subconscious', stored: twoStored, note: 'Someone needs you here.' });
  assert.equal(storedCutNoted.notice, undefined, 'its note speaks for the stored messages it saw, so no notice');
  assert.ok(!storedCutNoted.inferences.includes('Subconscious'), 'and no report turn');

  const nothingCut = cancelWith({ backlogCap: 10, source: 'subconscious', stored: twoStored });
  assert.equal(nothingCut.notice, undefined, 'with nothing cut and nothing unseen, no notice');
  assert.ok(!nothingCut.inferences.includes('Subconscious'), 'and no report turn');
});

// Review 2, J-AF29 (#232 gap 7): a write while a surgery holds the store is
// kept in memory until the hold's release, so a cancel during the hold read
// the record alone and its dump left the message out.
test("a cancel during a surgery's hold lists the held messages the hold keeps in memory, after those stored, and counts them against the cap", () => {
  const { dump, notice } = cancelWith({
    backlogCap: 2,
    source: 'duration',
    stored: [row('Ann', [text('A1 stored')], 'eA'), row('Ann', [text('A2 stored')], 'eA'), ...OTHERS],
    kept: [row('Ann', [text('A3 kept by the hold')], 'eA'), row('Bo', [text('B2 kept by the hold')], 'eB')],
  });
  assert.ok(dump.includes('messages=3') && dump.includes('truncated=1'), `the kept message is counted, and the cap leaves the oldest out: ${dump}`);
  assert.ok(dump.includes('Ann: A2 stored\nAnn: A3 kept by the hold'), 'it is the newest, shown last');
  assert.ok(!dump.includes('A1 stored') && !dump.includes('B2'), "the oldest is left out, and another epoch's kept message isn't the dump's");
  assert.ok(notice && textOf(notice.content).includes("1 of 3 diverted messages, the oldest, weren't delivered raw"), 'and the report is told so');
});

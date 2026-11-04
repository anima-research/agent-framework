/**
 * A tune-out cancel's `<tuned-out-backlog>` is one message in the residents'
 * shared slot, and a resident's strategy cuts a message past its per-message
 * cap from the end, which would lose the dump's newest lines while they still
 * counted as shown. So the dump holds the newest lines that fit whole in one
 * message of every resident that reads it, the ones it leaves out count as
 * truncated, and the subconscious's report notice is told of them. A newest
 * message too long to fit alone is shown cut and marked. The last two tests run
 * it through the framework, with context-manager's AutobiographicalStrategy for
 * the residents and test/tune-out-e2e.test.ts's MCPL fixture for the channel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { AgentFramework, AutobiographicalStrategy } from '../src/index.js';
import type { AgentConfig, Module } from '../src/index.js';
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

interface Row { participant: string; content: ContentBlock[]; metadata?: Record<string, unknown> }
interface Added { participant: string; content: ContentBlock[]; metadata?: Record<string, unknown>; forAgent?: string }

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const row = (author: string, t: string): Row =>
  ({ participant: 'user', content: [text(t)], metadata: { author: { name: author }, tuneOut: { epochId: 'eA' } } });
const textOf = (content: ContentBlock[]): string =>
  content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
const CUT_MARK = " [cut to fit; the whole message is in the channel's history]";

/** Stored messages, M1 the oldest, each line "Ann: Mk " and 40 x's. */
const stored = (n: number): Row[] => Array.from({ length: n }, (_, i) => row('Ann', `M${i + 1} ${'x'.repeat(40)}`));
const FIVE = stored(5);

/** Cancels epoch eA of disc:guild:a over the given messages, the residents
 *  shown `room` characters whole in one message (no cap when left out), and
 *  returns the dump's text, the report notice's, the rows after the notice
 *  and whose inference was requested. */
function cancelWith(opts: { backlogCap?: number; room?: number; source?: string; stored?: Row[]; held?: Row[]; note?: string }) {
  const added: Added[] = [];
  const inferences: string[] = [];
  const tunedOut = {
    params: { epochId: 'eA', cadenceSeconds: 300, backlogCap: opts.backlogCap ?? 20, maxWakes: 3, startedAtSequence: 0 },
    wakeCount: 0,
  };
  let ended = false;
  const registry = {
    // No other tune-out or all-except hold, and nothing else stored.
    getTuneOutState: (_serverId: string, channelId: string) => (!ended && channelId === 'disc:guild:a' ? tunedOut : null),
    readCoordinatorState: () => null,
    cancelTuneOut: () => { ended = true; return tunedOut; },
    // The dump names its channel as the resident is shown it: here its id.
    nameShown: (channel: { channelId: string }) => channel.channelId,
    quotedShown: (channel: { channelId: string }) => JSON.stringify(channel.channelId),
  };
  const hooks = {
    addMessage: (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, forAgent?: string) => {
      added.push({ participant, content, metadata, forAgent });
    },
    requestInference: (agentName: string) => { inferences.push(agentName); },
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => opts.stored ?? [],
    getDeferredMessages: () => opts.held ?? [],
    ...(opts.room !== undefined ? { residentMessageChars: () => opts.room } : {}),
    emitTrace: () => {},
  };
  const coordinator = new TuneOutCoordinator(registry as never, {} as never, hooks as never);
  assert.deepEqual(coordinator.cancel('disc', 'disc:guild:a', opts.source ?? 'agent-tool', 'test', opts.note), { ok: true });
  const dumpRow = added.find((m) => m.metadata?.kind === 'tune-out-cancel');
  assert.ok(dumpRow, 'the cancel adds its dump');
  assert.equal(dumpRow.content.length, 1, 'the dump is one text block');
  const notice = added.find((m) => m.metadata?.kind === 'tune-out-cancel-report');
  return {
    dump: textOf(dumpRow.content),
    notice: notice ? textOf(notice.content) : undefined,
    held: added.filter((m) => m.metadata?.kind === 'tune-out-cancel-held').map((m) => m.content),
    inferences,
  };
}

/** The dump's length when it shows the newest k of `msgs`, each whole:
 *  backlogCap k gives exactly that dump, with no room to fit. */
const lengthShowing = (k: number, msgs: Row[] = FIVE): number => cancelWith({ backlogCap: k, stored: msgs }).dump.length;
const shownOf = (dump: string): string[] => [1, 2, 3, 4, 5].map((k) => `M${k}`).filter((m) => dump.includes(`Ann: ${m} `));
/** The dump's lines, between its opening tag and its closing one. */
const linesOf = (dump: string): string[] => {
  const body = dump.slice(dump.indexOf('>\n') + 2, dump.lastIndexOf('\n</tuned-out-backlog>'));
  return body === '' ? [] : body.split('\n');
};

test('with room for the whole dump it shows every message, and one character less leaves the oldest out', () => {
  const whole = cancelWith({ room: lengthShowing(5), stored: FIVE });
  assert.deepEqual(shownOf(whole.dump), ['M1', 'M2', 'M3', 'M4', 'M5'], 'room for all five shows all five');
  assert.ok(whole.dump.includes('messages=5>'), 'and counts none as truncated');
  assert.ok(!whole.notice!.includes("weren't delivered raw"), 'so the report is told of none');

  const short = cancelWith({ room: lengthShowing(5) - 1, stored: FIVE });
  assert.ok(!shownOf(short.dump).includes('M1'), 'one character less leaves M1 out');
  assert.ok(shownOf(short.dump).includes('M5'), 'and keeps the newest');
  assert.ok(short.dump.length <= lengthShowing(5) - 1, 'and fits');
});

test('it keeps the newest lines that fit whole, counts those it leaves out, and tells the report how many', () => {
  const two = cancelWith({ room: lengthShowing(2), stored: FIVE });
  assert.deepEqual(shownOf(two.dump), ['M4', 'M5'], 'room for the newest two shows them');
  assert.ok(two.dump.includes('messages=5 truncated=3 (oldest; fetch_history covers the rest)>'), 'and counts the other three');
  assert.equal(two.dump.length, lengthShowing(2), 'filling the room exactly');
  assert.ok(two.dump.endsWith('</tuned-out-backlog>'), 'with its closing tag');
  assert.ok(two.notice!.includes("3 of 5 diverted messages, the oldest, weren't delivered raw to the resident."), 'the report is told of the three');

  const one = cancelWith({ room: lengthShowing(2) - 1, stored: FIVE });
  assert.deepEqual(shownOf(one.dump), ['M5'], 'one character less, and only the newest fits');
  assert.ok(one.dump.includes('messages=5 truncated=4 '), 'with the other four counted');
});

test('at every room, over six backlogs, the dump shows as many of the newest as fit whole, or the newest cut, fits, and counts the rest', () => {
  // Twelve takes truncated= across a digit as the fit keeps lines, and so does
  // twelve under a backlogCap of 9, which leaves some out before the fit; ten
  // under that cap crosses it between no line and one; a newest longer than
  // the mark reaches the cut, alone too, where showing it drops truncated=.
  const long = row('Bo', `NEWEST ${'y'.repeat(300)}`);
  const backlogs: Array<{ msgs: Row[]; cap?: number }> = [
    { msgs: FIVE }, { msgs: stored(12) }, { msgs: stored(10), cap: 9 }, { msgs: stored(12), cap: 9 },
    { msgs: [...FIVE, long] }, { msgs: [long] },
  ];
  for (const { msgs, cap } of backlogs) {
    const n = msgs.length;
    const most = Math.min(n, cap ?? n);
    const all = msgs.map((r) => `${(r.metadata!.author as { name: string }).name}: ${textOf(r.content)}`);
    let cuts = 0;
    // The dump with no line and all n counted: backlogCap 0 gives it.
    const frame = cancelWith({ backlogCap: 0, stored: msgs }).dump.length;
    // What of the newest line fits beside the frame for one shown and the mark.
    const roomForCut = (room: number): number => room - (lengthShowing(1, msgs) - all[n - 1]!.length) - CUT_MARK.length;
    for (let room = 0; room <= lengthShowing(most, msgs) + 2; room++) {
      const at = `over ${n}${cap !== undefined ? ` capped at ${cap}` : ''} at room ${room}`;
      const { dump, notice } = cancelWith({ room, stored: msgs, ...(cap !== undefined ? { backlogCap: cap } : {}) });
      const lines = linesOf(dump);
      assert.ok(lines.length <= most, `${at} no more lines than the cap allows`);
      if (lines.length > 0 && lines[0]!.endsWith(CUT_MARK)) {
        const head = lines[0]!.slice(0, -CUT_MARK.length);
        assert.equal(lines.length, 1, `${at} a cut line is the only one`);
        assert.ok(head.length > 0 && all[n - 1]!.startsWith(head), `${at} it's a head of the newest's line, not empty`);
        assert.ok(lengthShowing(1, msgs) > room, `${at} as the newest doesn't fit whole`);
        assert.equal(dump.length, room, `${at} and it fills the room`);
        cuts++;
      } else {
        assert.deepEqual(lines, all.slice(n - lines.length), `${at} the lines are the newest, whole`);
        if (lines.length > 0) assert.equal(dump.length, lengthShowing(lines.length, msgs), `${at} rendered as backlogCap ${lines.length} renders it`);
        if (lines.length < most) assert.ok(lengthShowing(lines.length + 1, msgs) > room, `${at} the next older line wouldn't fit`);
        if (lines.length === 0) assert.ok(roomForCut(room) <= 0, `${at} there's no room to show the newest cut`);
      }
      if (lines.length > 0 || room >= frame) assert.ok(dump.length <= room, `${at} the dump fits (it's ${dump.length})`);
      const counted = n - lines.length;
      if (counted === 0) assert.ok(!dump.includes('truncated='), `${at} none is counted as left out`);
      else {
        assert.ok(dump.includes(`messages=${n} truncated=${counted} (oldest;`), `${at} truncated= counts the ${counted} left out`);
        assert.ok(notice!.includes(`${counted} of ${n} diverted messages, the oldest,`), `${at} and the report is told of them`);
      }
    }
    assert.equal(cuts > 0, msgs.includes(long), `over ${n}, the newest is shown cut at some room exactly when it's longer than the mark`);
  }
});

test('a cut shows some of the newest or none: not under one character of room, nor half of a surrogate pair', () => {
  /** The room that leaves `head` characters for the newest's head, beside
   *  the dump's frame for one shown message and the mark. */
  const roomFor = (msgs: Row[], head: number): number => {
    const newest = msgs.at(-1)!;
    const line = `${(newest.metadata!.author as { name: string }).name}: ${textOf(newest.content)}`;
    return lengthShowing(1, msgs) - line.length + CUT_MARK.length + head;
  };
  const long = [...FIVE, row('Bo', `NEWEST ${'y'.repeat(300)}`)];
  // A fractional room, as a fractional maxMessageTokens gives.
  const half = cancelWith({ room: roomFor(long, 0.5), stored: long });
  assert.deepEqual(linesOf(half.dump), [], 'half a character shows nothing, not the mark alone');
  assert.ok(half.dump.includes('messages=6 truncated=6 '), 'and the newest is counted as left out');
  assert.deepEqual(linesOf(cancelWith({ room: roomFor(long, 1), stored: long }).dump), [`B${CUT_MARK}`], 'one character shows that character, marked');
  // An author whose name opens with an emoji: one code unit would split it.
  const emoji = [...FIVE, row('😀', `NEWEST ${'y'.repeat(300)}`)];
  assert.deepEqual(linesOf(cancelWith({ room: roomFor(emoji, 1), stored: emoji }).dump), [], 'room for half the pair shows nothing');
  assert.deepEqual(linesOf(cancelWith({ room: roomFor(emoji, 2), stored: emoji }).dump), [`😀${CUT_MARK}`], 'room for the pair shows it, marked');
});

test('a newest message too long to fit alone is shown cut to the room left and marked, with nothing older', () => {
  const long = row('Bo', `NEWEST ${'y'.repeat(500)}`);
  const room = lengthShowing(1) + 100;
  const { dump, notice } = cancelWith({ room, stored: [...FIVE, long] });
  assert.equal(dump.length, room, 'the dump fills the room');
  assert.ok(dump.includes(`\nBo: NEWEST yyy`) && dump.includes(`y${CUT_MARK}\n</tuned-out-backlog>`), "the newest message's head, marked as cut");
  assert.deepEqual(shownOf(dump), [], 'and no older message');
  assert.ok(dump.includes('messages=6 truncated=5 '), 'the five older ones are counted as left out');
  assert.ok(notice!.includes('5 of 6 diverted messages, the oldest,'), 'and the report is told of them');
});

test('a held newest message shown cut follows the notice with its content, as its view lacks it; a stored one is in its view', () => {
  const longText = `NEWEST ${'y'.repeat(500)}`;
  const room = lengthShowing(1) + 100;
  const held = cancelWith({ room, stored: FIVE, held: [row('Bo', longText)] });
  assert.ok(held.dump.includes(CUT_MARK), 'the held newest is shown cut');
  assert.ok(held.notice!.includes('the 1 message after this one'), 'the notice counts it');
  assert.deepEqual(held.held, [[text('Bo:'), text(longText)]], 'and it follows the notice with its content');

  const storedCut = cancelWith({ room, stored: [...FIVE, row('Bo', longText)] });
  assert.ok(storedCut.dump.includes(CUT_MARK), 'a stored newest is shown cut too');
  assert.deepEqual(storedCut.held, [], 'but no row follows the notice for it');
});

test('held messages the fit leaves out follow the notice as rows, and stored ones do not', () => {
  const storedTwo = [row('Ann', `S1 ${'x'.repeat(40)}`), row('Ann', `S2 ${'x'.repeat(40)}`)];
  const held = [row('Bo', `H1 ${'x'.repeat(40)}`), row('Bo', `H2 ${'x'.repeat(40)}`)];
  const roomForOne = cancelWith({ backlogCap: 1, stored: storedTwo, held }).dump.length;
  const { dump, notice, held: rows } = cancelWith({ room: roomForOne, stored: storedTwo, held });
  assert.ok(dump.includes('Bo: H2 ') && !dump.includes('H1 ') && !dump.includes('S1 ') && !dump.includes('S2 '), 'only the newest fits');
  assert.ok(notice!.includes("3 of 4 diverted messages, the oldest, weren't delivered raw to the resident."), 'the report is told of the three');
  assert.deepEqual(rows, [[text('Bo:'), text(`H1 ${'x'.repeat(40)}`)]], 'the held one left out follows the notice; the stored ones are in its view');
});

test('without a per-message cap the dump is not fitted', () => {
  const huge = `Bo: ${'z'.repeat(100_000)}`;
  const { dump } = cancelWith({ stored: [...FIVE, row('Bo', 'z'.repeat(100_000))] });
  assert.deepEqual(shownOf(dump), ['M1', 'M2', 'M3', 'M4', 'M5'], 'every message is shown');
  assert.ok(dump.includes(`\n${huge}\n</tuned-out-backlog>`), 'the 100,000-character one whole, last');
  assert.ok(!dump.includes('truncated=') && !dump.includes(CUT_MARK), 'none counted or cut');
});

test('a backlogCap of 0, or below 1, shows no message at any room', () => {
  const one = [row('Ann', `M1 ${'x'.repeat(40)}`)];
  for (let room = 0; room <= 400; room++) {
    const { dump } = cancelWith({ backlogCap: 0, room, stored: one });
    assert.deepEqual(linesOf(dump), [], `at room ${room}, no line`);
    assert.ok(dump.includes('messages=1 truncated=1 '), `at room ${room}, the one message counted`);
  }
  const half = cancelWith({ backlogCap: 0.5, stored: FIVE });
  assert.deepEqual(linesOf(half.dump), [], 'a cap of 0.5 shows none');
  assert.ok(half.dump.includes('messages=5 truncated=5 '), 'and counts all five');
});

test('the cut never ends on half of a surrogate pair', () => {
  const room = lengthShowing(1) + 100;
  // Each 😀 is two code units, so with one pad or the other the cut lands
  // between them unless it's moved.
  for (const pad of [0, 1]) {
    const { dump } = cancelWith({ room, stored: [...FIVE, row('Bo', `${'p'.repeat(pad)}${'😀'.repeat(400)}`)] });
    const lines = linesOf(dump);
    assert.equal(lines.length, 1, `with pad ${pad}, one line`);
    assert.ok(lines[0]!.startsWith('Bo: ') && lines[0]!.endsWith(CUT_MARK), `with pad ${pad}, the newest shown cut`);
    const head = lines[0]!.slice(0, -CUT_MARK.length);
    const last = head.charCodeAt(head.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `with pad ${pad}, it doesn't end on a high surrogate`);
    assert.ok(dump.length <= room, 'and fits');
  }
});

test('a cancel the subconscious makes itself with no note gets the notice and a report turn when the fit left messages out', () => {
  const cut = cancelWith({ room: lengthShowing(2), source: 'subconscious', stored: FIVE });
  assert.ok(cut.notice?.includes('3 of 5 diverted messages, the oldest,'), 'nothing else covers them, so the notice comes');
  assert.ok(cut.inferences.includes('Subconscious'), 'with a report turn');
  const whole = cancelWith({ room: lengthShowing(5), source: 'subconscious', stored: FIVE });
  assert.equal(whole.notice, undefined, 'with room for all, no notice');
  assert.ok(!whole.inferences.includes('Subconscious'), 'and no report turn');
});

// ---------------------------------------------------------------------------
// Through the framework.
// ---------------------------------------------------------------------------

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const CHANNEL = 'disc:guild:noisy';
const MARKERS = [1, 2, 3, 4, 5, 6].map((k) => `P-MSG-${k}`);
/** Each marker's line in the dump: 155 characters, six to a 1,079-character dump. */
const lineFor = (mk: string): string => `antra: ${mk} ${'x'.repeat(140)}`;

interface Internals {
  tuneOutCoordinator: TuneOutCoordinator | null;
  agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: ContentBlock[]; metadata?: Record<string, unknown> }> } }>;
  channelRegistry: { listChannelsRaw(): unknown[] } | null;
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const autobiographical = (maxMessageTokens: number) => new AutobiographicalStrategy({
  adaptiveResolution: true,
  foldingStrategy: 'kv-stable',
  recentWindowTokens: 30_000,
  kvStableReachTokens: 8_000,
  maxMessageTokens,
}) as never;

/** A framework with the given residents (the first is the primary) and a
 *  subconscious, the fixture's channel tuned out at backlogCap 10, six
 *  messages diverted, and then a cancel from the resident. `check` reads it. */
async function cancelSix(agents: AgentConfig[], check: (x: { framework: AgentFramework; internals: Internals; membrane: MockMembrane; callsBefore: number }) => Promise<void>, modules: Module[] = []): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'tune-out-dump-fit-'));
  const commandPath = join(tempDir, 'commands.txt');
  writeFileSync(commandPath, '');
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents,
    subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' },
    mcplServers: [{
      id: 'disc',
      command: process.execPath,
      args: [FIXTURE],
      env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
    }],
    modules,
  });
  try {
    await framework.start();
    const internals = framework as unknown as Internals;
    await waitFor('channel registration', () => (internals.channelRegistry?.listChannelsRaw().length ?? 0) > 0);
    assert.ok(internals.tuneOutCoordinator!.enter('disc', CHANNEL, { cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, 'agent-tool').ok);
    for (const mk of MARKERS) appendFileSync(commandPath, `ambient ${mk.toLowerCase()} ${mk} ${'x'.repeat(140)}\n`);
    const slot = () => internals.agents.get(agents[0]!.name)!.getContextManager().getAllMessages();
    await waitFor('all six stored', () => MARKERS.every((mk) => slot().some((m) => textOf(m.content).includes(mk) && m.metadata?.tuneOut)));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack one' }]));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack two' }]));
    const callsBefore = membrane.calls.length;
    assert.ok(internals.tuneOutCoordinator!.cancel('disc', CHANNEL, 'agent-tool', 'agent request').ok);
    await check({ framework, internals, membrane, callsBefore });
  } finally {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** The one dump among a request's messages. */
function dumpIn(messages: Array<{ content: ContentBlock[] }>, whose: string): string {
  const dumps = messages.map((m) => textOf(m.content)).filter((t) => t.includes('<tuned-out-backlog'));
  assert.equal(dumps.length, 1, `${whose} carries the dump`);
  return dumps[0]!;
}

/** The dump the cap of 170 tokens fits: 680 characters, room for its frame
 *  and the newest three lines, where all six take 1,079. */
function assertNewestThreeWhole(dump: string, whose: string): void {
  for (const mk of ['P-MSG-4', 'P-MSG-5', 'P-MSG-6']) assert.ok(dump.includes(`${lineFor(mk)}\n`), `${whose} shows ${mk} whole`);
  for (const mk of ['P-MSG-1', 'P-MSG-2', 'P-MSG-3']) assert.ok(!dump.includes(mk), `${whose} leaves out ${mk}`);
  // The note names the history tool the resident has (#232 gap 11); this rig's server offers none, so it says so.
  assert.ok(dump.includes('messages=6 truncated=3 (oldest; not delivered)>'), `${whose} counts the three as left out`);
  assert.ok(dump.endsWith('</tuned-out-backlog>') && !dump.includes('[truncated'), `${whose} gets it with no cut by the strategy`);
}

function assertNoticeCountsThree(internals: Internals): void {
  const notice = internals.agents.get('Subconscious')!.getContextManager().getAllMessages()
    .find((m) => textOf(m.content).includes('[Tune-out cancelled:'));
  assert.ok(notice, 'the report gets its notice');
  assert.ok(textOf(notice.content).includes("3 of 6 diverted messages, the oldest, weren't delivered raw to the resident."), 'which tells it of the three');
}

test("the resident is shown the newest backlog lines whole under its strategy's per-message cap, and the report is told of the rest", async () => {
  await cancelSix(
    [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', strategy: autobiographical(170) }],
    async ({ internals, membrane, callsBefore }) => {
      const isScout = (r: NormalizedRequest): boolean => (r.system ?? '').includes('You are scout.');
      await waitFor("the resident's request after the cancel", () => membrane.calls.slice(callsBefore).some(isScout));
      assertNewestThreeWhole(dumpIn(membrane.calls.slice(callsBefore).find(isScout)!.messages, "the resident's request"), "the resident's request");
      assertNoticeCountsThree(internals);
    },
  );
});

test('the note names the history tool the resident has (#232 gap 11)', async () => {
  const history: Module = {
    name: 'history',
    async start() {},
    async stop() {},
    async onProcess() { return {}; },
    getTools: () => [{ name: 'fetch_history', description: "reads a channel's history", inputSchema: { type: 'object', properties: {} } }],
    async handleToolCall() { return { success: true, data: 'none' }; },
  };
  await cancelSix(
    [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', strategy: autobiographical(170), allowedTools: 'all' }],
    async ({ membrane, callsBefore }) => {
      const isScout = (r: NormalizedRequest): boolean => (r.system ?? '').includes('You are scout.');
      await waitFor("the resident's request after the cancel", () => membrane.calls.slice(callsBefore).some(isScout));
      const dump = dumpIn(membrane.calls.slice(callsBefore).find(isScout)!.messages, "the resident's request");
      assert.ok(dump.includes('messages=6 truncated=3 (oldest; history--fetch_history covers the rest)>'), dump.slice(0, 200));
    },
    [history],
  );
});

test('the dump fits the smallest per-message cap among the residents that read it', async () => {
  // The primary's cap would hold all six; the second resident's holds three.
  await cancelSix(
    [
      { name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', strategy: autobiographical(10_000) },
      { name: 'ward', model: 'test-model', systemPrompt: 'You are ward.', strategy: autobiographical(170) },
    ],
    async ({ framework, internals, membrane, callsBefore }) => {
      const isScout = (r: NormalizedRequest): boolean => (r.system ?? '').includes('You are scout.');
      await waitFor("the primary's request after the cancel", () => membrane.calls.slice(callsBefore).some(isScout));
      assertNewestThreeWhole(dumpIn((await framework.previewActivation('ward')).messages, "the second resident's view"), "the second resident's view");
      assertNewestThreeWhole(dumpIn(membrane.calls.slice(callsBefore).find(isScout)!.messages, "the primary's request"), "the primary's request");
      assertNoticeCountsThree(internals);
    },
  );
});

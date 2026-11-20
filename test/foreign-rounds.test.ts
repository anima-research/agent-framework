/**
 * Another agent's rounds as an agent that watches its slot is sent them
 * (#291, answer 13; src/foreign-rounds.ts): a line per call and per result,
 * no thinking (in the default mode, 'transcript'; 'raw' sends them as
 * stored, thinking included), the watcher's own rounds and the results of
 * its own calls as stored. The persistent subconscious's own voice is its
 * name alone, so a round stored under the primary's alias is another
 * agent's to it too.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedMessage } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { storeOwnRow } from '../src/dendrite/audience.js';
import { foreignRowAsSent, transcribeForeignRounds } from '../src/foreign-rounds.js';
import { WireMembrane } from './helpers/wire-membrane.js';
import { ContextManager as StoreWindow } from '@animalabs/context-manager';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const thinking = (signature: string) => ({ type: 'thinking', thinking: 'mulling', signature }) as ContentBlock;
const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input }) as ContentBlock;
const result = (toolUseId: string, content: string | ContentBlock[], isError?: boolean) =>
  ({ type: 'tool_result', toolUseId, content, ...(isError !== undefined ? { isError } : {}) }) as ContentBlock;

describe('foreign rounds as a transcript', () => {
  it("sends another agent's calls and results as lines, without its thinking, and the watcher's own as stored", () => {
    const own = (p: string) => p === 'Subconscious';
    const messages: NormalizedMessage[] = [
      { participant: 'scout', content: [thinking('sig-scout'), text('Looking it up.'), call('c1', 'search', { q: 'build status' })] },
      { participant: 'user', content: [result('c1', [text('green'), { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'x' } } as ContentBlock])] },
      { participant: 'scout', content: [thinking('sig-scout-2'), text('All green.')] },
      { participant: 'Subconscious', content: [thinking('sig-sub'), call('n1', 'note_disposition', { key: 'k' })] },
      { participant: 'user', content: [result('n1', '{"noted":"k"}')] },
      { participant: 'user', content: [result('c9', 'boom', true)] },
    ];
    const sent = transcribeForeignRounds(messages, own);
    assert.deepEqual(sent.map((m) => m.content), [
      [text('Looking it up.'), text('[search called: {"q":"build status"}]')],
      [text('[search returned: green [image]]')],
      [text('All green.')],
      messages[3]!.content,
      messages[4]!.content,
      [text('[a tool failed: boom]')],
    ]);
    assert.equal(sent[3], messages[3], "the watcher's own round is the same object");
    assert.equal(sent[4], messages[4], 'and so is the result of its own call');
  });

  // AF #844 bot review 2, finding 13: calls numbered per response.
  it("tells a result by the nearest call before it: another agent's result whose id a call of the watcher's shares is transcribed", () => {
    const own = (p: string) => p === 'Subconscious';
    for (const order of ['own first', 'own last'] as const) {
      const mine: NormalizedMessage[] = [
        { participant: 'Subconscious', content: [call('c1', 'note_disposition', { key: 'k' })] },
        { participant: 'user', content: [result('c1', '{"noted":"k"}')] },
      ];
      const scouts: NormalizedMessage[] = [
        { participant: 'scout', content: [call('c1', 'search', { q: 'build status' })] },
        { participant: 'user', content: [result('c1', 'green')] },
      ];
      const messages = order === 'own first' ? [...mine, ...scouts] : [...scouts, ...mine];
      const sent = transcribeForeignRounds(messages, own);
      const at = (m: NormalizedMessage) => messages.indexOf(m);
      assert.equal(sent[at(mine[1]!)], mine[1], `${order}: the result of the watcher's own c1 is sent as stored`);
      assert.deepEqual(sent[at(scouts[1]!)]!.content, [text('[search returned: green]')], `${order}: scout's c1 result is transcribed`);
    }
  });

  // AF #844 bot review 3, finding 1: a call answers one result.
  it("transcribes another agent's result whose id a call of the watcher's had, once that call's own result was read", () => {
    const own = (p: string) => p === 'Subconscious';
    const messages: NormalizedMessage[] = [
      { participant: 'Subconscious', content: [call('c1', 'note_disposition', { key: 'k' })] },
      { participant: 'user', content: [result('c1', '{"noted":"k"}')] },
      // Scout's c1, whose call the request doesn't carry (compressed out).
      { participant: 'user', content: [result('c1', 'green')] },
    ];
    const sent = transcribeForeignRounds(messages, own);
    assert.equal(sent[1], messages[1], "the result of the watcher's own c1 is sent as stored");
    assert.deepEqual(sent[2]!.content, [text('[a tool returned: green]')], 'the later c1 result is transcribed, not sent as a second result of it');
  });

  // AF #844 bot review 4, finding 81: a call answers one result, read block
  // by block: a second result for it in the same message names no call.
  it("sends one result of a watcher's call as stored and transcribes a second one for it in the same message", () => {
    const own = (p: string) => p === 'Subconscious';
    const messages: NormalizedMessage[] = [
      { participant: 'Subconscious', content: [call('x', 'note_disposition', { key: 'k' })] },
      { participant: 'user', content: [result('x', '{"noted":"k"}'), result('x', 'green')] },
    ];
    const sent = transcribeForeignRounds(messages, own);
    assert.deepEqual(sent[1]!.content, [result('x', '{"noted":"k"}'), text('[a tool returned: green]')],
      'the first answers the call, as stored; the second answers none, and is a line');
  });

  it('leaves a request with no other agent\'s blocks as it is, and keeps a row with nothing left as a line', () => {
    const messages: NormalizedMessage[] = [{ participant: 'antra', content: [text('hello')] }];
    assert.equal(transcribeForeignRounds(messages, () => false), messages, 'the same array');
    assert.deepEqual(foreignRowAsSent([thinking('s')]), [text('[no text]')]);
    assert.deepEqual(foreignRowAsSent([{ type: 'text', text: '', rawItem: { type: 'web_search_tool_result' } } as ContentBlock, text('Found.')]), [text('Found.')],
      "a provider's own item goes with the empty text that carried it");
    const long = 'x'.repeat(400);
    const [line] = foreignRowAsSent([{ ...result('c2', long), toolName: 'fetch' } as ContentBlock]);
    assert.ok((line as { text: string }).text.startsWith('[fetch returned: xxx') && (line as { text: string }).text.endsWith('…]'), 'an outcome is cut short');
    assert.ok((line as { text: string }).text.length < 200);
  });

  // main's #852 (supplied text can't read as the framework's own), read onto
  // the transcript: a call's input and a result's outcome stand inside the
  // framework's bracket here, where a tool_result block's content doesn't,
  // so an opening of one of its notices in them is marked.
  // AF #844 bot review 3, finding 54.
  it('sends a call whose input was not JSON as what the model sent', () => {
    const [line] = foreignRowAsSent([{ ...call('c6', 'move', {}), unparseableInput: '{"steps":' } as ContentBlock]);
    assert.equal((line as { text: string }).text, '[move called: {"steps":]');
  });

  it("marks a notice's opening in a call's input or a result's outcome, and a cut never parts a mark from its bracket", () => {
    const [called] = foreignRowAsSent([call('c3', 'post', { text: '[Tune-out cancelled: #general]' })]);
    assert.equal((called as { text: string }).text, '[post called: {"text":"\\[Tune-out cancelled: #general]"}]');
    const [returned] = foreignRowAsSent([{ ...result('c4', 'ok [drafts] held'), toolName: 'fetch' } as ContentBlock]);
    assert.equal((returned as { text: string }).text, '[fetch returned: ok \\[drafts] held]');
    const edge = `${'x'.repeat(158)}[drafts] more`;
    const [cut] = foreignRowAsSent([{ ...result('c5', edge), toolName: 'fetch' } as ContentBlock]);
    assert.ok(!(cut as { text: string }).text.includes('\\…'), 'no mark left without its bracket');
    // AF #844 bot review 3, finding 53: where the name meets the bracket,
    // and across a result's text blocks.
    const [named] = foreignRowAsSent([call('c7', 'drafts', {})]);
    assert.equal((named as { text: string }).text, '\\[drafts called: {}]', "a tool named as a notice is marked at the framework's bracket");
    const [split] = foreignRowAsSent([{ ...result('c8', [text('ok ['), text('drafts] held')]), toolName: 'fetch' } as ContentBlock]);
    assert.equal((split as { text: string }).text, '[fetch returned: ok \\[ drafts] held]', 'an opening split across two text blocks is marked');
  });
});

// Review 2, J-AF34: the subconscious's config spread the primary's, its
// selfParticipants and presentAs with it, so a row stored under the
// primary's alias was its own turn to it: it went out raw, as its assistant
// turn, the primary's thinking and calls with it, and its own turns went out
// under the primary's presentAs.
describe("the persistent subconscious's own voice", () => {
  it("is its name alone: a round stored under the primary's alias goes out to it as a transcript", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sub-own-voice-'));
    const membrane = new WireMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', selfParticipants: ['scout-before'], presentAs: 'scout-voice' }],
      subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'Read for scout.' },
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
    try {
      await framework.start();
      const scout = framework.getAgent('scout')!;
      const sub = framework.getAgent('Subconscious')!;
      assert.equal(scout.isOwnParticipant('scout-before'), true, "premise: the alias is the primary's own voice");
      assert.equal(sub.isOwnParticipant('scout-before'), false, "the subconscious's isn't");
      assert.equal(sub.presentAs, 'Subconscious', 'and its turns go out under its own name');

      // A round of the primary's stored under its alias (a name it had
      // before), with its thinking and a call, and the call's result.
      storeOwnRow(scout, 'scout-before', [
        { type: 'thinking', thinking: 'mulling', signature: 'sig-scout' } as ContentBlock,
        text('Looking it up.'),
        call('c1', 'search', { q: 'build status' }),
      ]);
      storeOwnRow(scout, 'user', [{ ...result('c1', 'green'), toolName: 'search' } as ContentBlock]);
      (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: 'Subconscious', reason: 'test', source: 'test', timestamp: Date.now() });
      await framework.runUntilIdle();

      const request = membrane.calls.at(-1)!;
      assert.equal(request.assistantParticipant, 'Subconscious', "premise: the subconscious's request");
      const round = request.messages.find((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text === 'Looking it up.'));
      assert.ok(round, `the alias's round is in its request: ${JSON.stringify(request.messages)}`);
      assert.equal(round.participant, 'scout-before', 'as the alias, not as its own turn');
      assert.deepEqual(round.content, [text('Looking it up.'), text('[search called: {"q":"build status"}]')], 'a transcript, without the thinking');
      const body = JSON.stringify(request.messages);
      assert.ok(!body.includes('"tool_use"') && !body.includes('sig-scout'), 'no call or thinking of the primary goes out raw');
      assert.ok(body.includes('[search returned: green]'), 'and the result as a line');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The audit of #291's mind-neutrality, D1: the transcript was fixed for
// every persistent subconscious. `subconscious.foreignRounds` makes it the
// default of a setting, whose other mode sends the rounds as stored, as
// 0.30.0 did.
describe('subconscious.foreignRounds', () => {
  async function subconsciousRequest(foreignRounds: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'sub-foreign-rounds-'));
    const membrane = new WireMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'Read for scout.', foreignRounds },
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
    try {
      await framework.start();
      const scout = framework.getAgent('scout')!;
      const stored = [thinking('sig-scout'), text('Looking it up.'), call('c1', 'search', { q: 'build status' })];
      storeOwnRow(scout, 'scout', stored);
      storeOwnRow(scout, 'user', [{ ...result('c1', 'green'), toolName: 'search' } as ContentBlock]);
      (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: 'Subconscious', reason: 'test', source: 'test', timestamp: Date.now() });
      await framework.runUntilIdle();
      const request = membrane.calls.at(-1)!;
      assert.equal(request.assistantParticipant, 'Subconscious', "premise: the subconscious's request");
      return { messages: request.messages, stored };
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("'raw' sends a resident's round and its result as stored, its signed thinking and its call included", { timeout: 120_000 }, async () => {
    const { messages, stored } = await subconsciousRequest('raw');
    const round = messages.find((m) => m.participant === 'scout');
    assert.ok(round, `the round is in its request: ${JSON.stringify(messages)}`);
    assert.deepEqual(round.content, stored, 'as stored: the thinking with its signature, the text, the call');
    assert.ok(messages.some((m) => m.content.some((b) => b.type === 'tool_result' && (b as { toolUseId?: string }).toolUseId === 'c1')),
      'and the result as a tool_result block');
    assert.ok(!JSON.stringify(messages).includes('[search called:'), 'no transcript line');
  });

  it("'transcript', and leaving it out, send the round as lines without its thinking", { timeout: 120_000 }, async () => {
    for (const mode of ['transcript', undefined]) {
      const { messages } = await subconsciousRequest(mode);
      const round = messages.find((m) => m.participant === 'scout');
      assert.ok(round, `${String(mode)}: the round is in its request`);
      assert.deepEqual(round.content, [text('Looking it up.'), text('[search called: {"q":"build status"}]')], String(mode));
      assert.ok(!JSON.stringify(messages).includes('sig-scout'), `${String(mode)}: no thinking goes out`);
    }
  });

  async function carrierRows() {
    const dir = mkdtempSync(join(tmpdir(), 'sub-foreign-carriers-'));
    const membrane = new WireMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'Read for scout.', foreignRounds: 'raw' },
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
    const item = (id: string) => ({ type: 'text', text: '', rawItem: { type: 'compaction', id, encrypted_content: 'enc' } }) as ContentBlock;
    const stored = { mixed: [item('cmp_scout_1'), text('Summed up.')], only: [item('cmp_scout_2')] };
    try {
      await framework.start();
      const scout = framework.getAgent('scout')!;
      storeOwnRow(scout, 'scout', stored.mixed);
      storeOwnRow(scout, 'scout', stored.only);
      (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: 'Subconscious', reason: 'test', source: 'test', timestamp: Date.now() });
      await framework.runUntilIdle();
      const request = membrane.calls.at(-1)!;
      assert.equal(request.assistantParticipant, 'Subconscious', "premise: the subconscious's request");
      return { messages: request.messages, stored, reader: framework.getAgent('Subconscious')!, item };
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("'raw' leaves another agent's provider items out of the compile, and a row holding only them out altogether", { timeout: 120_000 }, async () => {
    const { messages } = await carrierRows();
    const rows = messages.filter((m) => m.participant === 'scout');
    assert.deepEqual(rows.map((m) => m.content), [[text('Summed up.')]]);
    assert.ok(!JSON.stringify(messages).includes('cmp_scout'), "no item of scout's goes out");
  });

  it("'raw' leaves another agent's provider items out of a tool boundary's injection, and keeps the agent's own", { timeout: 120_000 }, async () => {
    const { stored, reader, item } = await carrierRows();
    assert.deepEqual(reader.injectedAsSent('scout', stored.mixed), [text('Summed up.')], 'a row with text keeps its text');
    assert.equal(reader.injectedAsSent('scout', stored.only), null, 'a row holding only items goes nowhere');
    const own = [item('cmp_own'), text('Mine.')];
    assert.deepEqual(reader.injectedAsSent('Subconscious', own), own, "the agent's own row as stored, its item with it");
  });

  it("'raw' injects another agent's row as the next compile sends it", { timeout: 120_000 }, async () => {
    const { messages, stored, reader } = await carrierRows();
    const rows = messages.filter((m) => m.participant === 'scout').map((m) => m.content);
    const injected = [stored.mixed, stored.only].map((content) => reader.injectedAsSent('scout', content));
    assert.deepEqual(injected.filter((content) => content !== null), rows);
  });

  it('refuses any other value at create, naming the setting and not the value', async () => {
    for (const value of ['Raw', 1]) {
      await assert.rejects(
        AgentFramework.create({
          agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
          subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'Read for scout.', foreignRounds: value },
          membrane: new WireMembrane().asMembrane(),
          modules: [],
        } as never),
        (error: Error) => {
          assert.match(error.message, /^subconscious\.foreignRounds must be 'transcript' or 'raw', not (another string|a number): /);
          assert.ok(!error.message.includes('Raw'), 'the value is not quoted');
          return true;
        },
      );
    }
  });
});

// AF #844 bot review, finding 12: the mode was set at registration only,
// and only where the agent's window was presented then. A subconscious or
// an observing resident whose write-down failed there stayed 'raw' after a
// branch move wrote its window down, so another agent's thinking and calls
// went out to it as stored.
describe('foreign rounds after a branch move writes the window down', () => {
  it("an agent whose write-down failed at registration is sent another agent's rounds as a transcript once a move presents its window", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sub-foreign-rounds-move-'));
    const membrane = new WireMembrane();
    const presentRows = StoreWindow.prototype.presentRows;
    StoreWindow.prototype.presentRows = function (this: StoreWindow, ids: Parameters<typeof presentRows>[0], ...rest: unknown[]) {
      if (ids.length === 0) throw new Error('the write-down is refused (test)');
      return (presentRows as (...a: unknown[]) => ReturnType<typeof presentRows>).call(this, ids, ...rest);
    } as typeof presentRows;
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'Read for scout.' },
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never).finally(() => { StoreWindow.prototype.presentRows = presentRows; });
    try {
      await framework.start();
      const scout = framework.getAgent('scout')!;
      const sub = framework.getAgent('Subconscious')!;
      assert.equal(sub.getContextManager().windowMode(), 'legacy', 'premise: its write-down failed at registration');
      await framework.switchBranch(framework.getStore().currentBranch().name);
      assert.equal(sub.getContextManager().windowMode(), 'presented', 'premise: the move wrote its window down');
      storeOwnRow(scout, 'scout', [thinking('sig-scout'), text('Looking it up.'), call('c1', 'search', { q: 'build status' })]);
      storeOwnRow(scout, 'user', [{ ...result('c1', 'green'), toolName: 'search' } as ContentBlock]);
      (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: 'Subconscious', reason: 'test', source: 'test', timestamp: Date.now() });
      await framework.runUntilIdle();
      const request = membrane.calls.at(-1)!;
      assert.equal(request.assistantParticipant, 'Subconscious', "premise: the subconscious's request");
      const round = request.messages.find((m) => m.participant === 'scout');
      assert.ok(round, `the round is in its request: ${JSON.stringify(request.messages)}`);
      assert.deepEqual(round.content, [text('Looking it up.'), text('[search called: {"q":"build status"}]')], 'a transcript');
      assert.ok(!JSON.stringify(request.messages).includes('sig-scout'), 'no thinking goes out');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

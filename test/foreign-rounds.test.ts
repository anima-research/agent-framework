/**
 * Another agent's rounds as an agent that watches its slot is sent them
 * (#291, answer 13; src/foreign-rounds.ts): a line per call and per result,
 * no thinking, the watcher's own rounds and the results of its own calls as
 * stored. The persistent subconscious's own voice is its name alone, so a
 * round stored under the primary's alias is another agent's to it too.
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

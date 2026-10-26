/**
 * Another agent's rounds as an agent that watches its slot is sent them
 * (#291, answer 13; src/foreign-rounds.ts): a line per call and per result,
 * no thinking, the watcher's own rounds and the results of its own calls as
 * stored.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock, NormalizedMessage } from '@animalabs/membrane';
import { foreignRowAsSent, transcribeForeignRounds } from '../src/foreign-rounds.js';

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

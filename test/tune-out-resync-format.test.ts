/**
 * How the default reader framing writes a row (AF #967 bot review findings
 * 5 and 23): the resident's rows a resumed persisted reader is handed
 * (`residentRows`), each under its author, and a line for every row the
 * count line counts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { defaultReaderFraming } from '../src/index.js';
import type { ReaderFramingContext } from '../src/index.js';
import { ANONYMOUS_PARTICIPANT } from '../src/author-presentation.js';

const IMAGE = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } } as ContentBlock;
const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
let seq = 0;
const row = (participant: string, content: ContentBlock[], metadata: Record<string, unknown> = {}) =>
  ({ id: `r-${++seq}`, sequence: seq, participant, content, metadata }) as unknown as StoredMessage;
const by = (name: string) => ({ author: { id: `u-${name}`, name } });

const base: ReaderFramingContext = {
  resident: 'scout', fork: 'reader/scout/g1', voice: 'Read for scout.', channelId: 'disc:guild:noisy', epochId: 'abcdef0123',
  trigger: 'cadence', notice: '[Tune-out cadence: test]', dispositions: null, backlog: [],
};
const resynced = (rows: StoredMessage[]) => ({ ...base, resumed: true, incarnation: 2, residentRows: rows });

/** The framing's blocks after its header: a text block as its text, anything else by kind. */
const shape = (out: ContentBlock[]) => out.slice(1).map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`));

const NOTHING_HELD = '\n[Nothing new has been held since your last look.]';
const NOTHING_ENTERED = "\n[Nothing has entered scout's context since your last look.]";

describe("the resident's rows in the reader framing", () => {
  it("names the author of a row that holds media and no text, before its media (finding 5)", () => {
    const out = defaultReaderFraming(resynced([
      row('scout', [text('here is the chart')]),
      row(ANONYMOUS_PARTICIPANT, [IMAGE], by('antra')),
    ]));
    assert.deepEqual(shape(out), [
      "\n[In scout's context since your last look: 2 messages]\nscout: here is the chart\nantra: ",
      '<image>',
      NOTHING_HELD,
    ]);
  });

  it('a row with media and no author to name has its media and no line of its own', () => {
    const out = defaultReaderFraming(resynced([row('scout', [text('before')]), row(ANONYMOUS_PARTICIPANT, [IMAGE])]));
    assert.deepEqual(shape(out), [
      "\n[In scout's context since your last look: 2 messages]\nscout: before",
      '<image>',
      NOTHING_HELD,
    ]);
  });

  it('an empty row reads [no text] under its author, so there is a line for each row counted (finding 23)', () => {
    const rows = [
      row('scout', []),
      row(ANONYMOUS_PARTICIPANT, [text('')], by('antra')),
      row(ANONYMOUS_PARTICIPANT, []),
      row('scout', [{ type: 'thinking', thinking: 'SECRET-THOUGHT', signature: 's' } as ContentBlock]),
      row('scout', [text('after')]),
    ];
    const out = defaultReaderFraming(resynced(rows));
    const [block, held] = shape(out);
    assert.equal(block, [
      "\n[In scout's context since your last look: 5 messages]",
      'scout: [no text]',
      'antra: [no text]',
      '[no text]',
      'scout: [no text]',
      'scout: after',
    ].join('\n'));
    assert.equal(block!.split('\n').length - 2, rows.length, 'a line per row, after the count line');
    assert.equal(held, NOTHING_HELD);
  });

  it('with no rows, says nothing entered, as before', () => {
    assert.deepEqual(shape(defaultReaderFraming(resynced([]))), [NOTHING_ENTERED, NOTHING_HELD]);
  });
});

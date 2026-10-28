import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_MANAGER_TAGS, NOTICE_TAG } from '../src/notice-tags.js';
import { cutToFit, markedText, markedTexts, holdersOf, markNoticeOpenings, nameToTypeBack, quotedValue, suppliedValue } from '../src/supplied-text.js';
import { convertBlocks } from '../src/mcpl/convert-block.js';
import type { McplContentBlock } from '../src/mcpl/types.js';

const BREAKS = ['\r\n', '\r', '\n', '\u000b', '\u000c', '\u0085', '\u2028', '\u2029'];
const LINE_BREAK = /[\r\n\u000b\u000c\u0085\u2028\u2029]/;

describe('marking many texts', () => {
  it('marks each of many tagged texts as it marks one alone', () => {
    const texts = Array.from({ length: 10_000 }, (_, i) => (i % 2 ? `[${NOTICE_TAG.routing}] ${i}` : `plain ${i}`));
    const marked = markedTexts(texts);
    assert.equal(marked.length, texts.length);
    for (let i = 0; i < texts.length; i++) {
      assert.equal(marked[i], i % 2 ? `\\${texts[i]}` : texts[i], String(i));
    }
    // An empty text holds no opening, and the texts after it keep their own.
    assert.deepEqual(markedTexts(['a', '', `[${NOTICE_TAG.routing}] b`]), ['a', '', `\\[${NOTICE_TAG.routing}] b`]);
  });

  it("finds the text that holds each of many openings in one walk through the texts' starts", () => {
    const n = 2_000;
    let reads = 0;
    const starts = new Proxy(Array.from({ length: n }, (_, i) => i * 10), {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const places = Array.from({ length: n }, (_, i) => i * 10 + 3);
    assert.deepEqual(holdersOf(starts, places), places.map((_, i) => i));
    // The walk reads one start for each step forward, n - 1 in all, and at most one more where each place stops it.
    // A search back from the last text for each place reads about n * n / 2.
    assert.ok(reads <= 2 * n, `${reads} reads of the starts for ${n} places`);
  });
});

describe('notice openings in text the framework did not write', () => {
  it('marks the opening of every listed tag, as a notice writes it, wherever it stands', () => {
    for (const tag of [...Object.values(NOTICE_TAG), ...CONTEXT_MANAGER_TAGS]) {
      for (const text of [`[${tag}]`, `[${tag}: x]`, `[${tag} x]`, `said: [${tag}] x`, `a\n[${tag}] x`]) {
        const at = text.indexOf('[');
        assert.equal(markedText(text), `${text.slice(0, at)}\\${text.slice(at)}`, JSON.stringify(text));
      }
    }
  });

  it('marks each opening context-manager 0.23.0 writes or reads back', () => {
    for (const text of ['[content omitted: x]', '[image not shown: x]', '[Operator note — x]', '[Recall r1]', '[tool call omitted]', '[tool result moved during context repair]', '[Topic Transition]']) {
      assert.equal(markedText(text), `\\${text}`, text);
    }
  });

  it('marks each opening membrane 0.8.0 writes into a request, and ordinary text its Image tag reaches too', () => {
    for (const text of [
      '[continuing]', '[Image 2]', '[Image omitted]', '[Tool Result: x]', '[image of a cat]', '[Start]',
      '[orphan tool_result for t1]: x', '[duplicate tool_result for t1, an error]: x',
      '[Document: application/pdf, ~3KB, not shown to you]', '[Audio: audio/wav, ~3KB, not shown to you]', '[Video: video/mp4, ~3KB, not shown to you]',
    ]) {
      assert.equal(markedText(text), `\\${text}`, text);
    }
  });

  it('marks an opening in any case, and through whitespace, controls and invisible characters inside its bracket, between its words too', () => {
    for (const text of [
      '[DRAFTS]', '[ drafts ]', '[dr\u200bafts]', '[dra\u0085fts]', '[\u017fystem]', '[Tune-out\u2060 wake: x]',
      '[closed\u00a0channel]', '[closed\u0085channel]', '[closed\u200bchannel]', '[Channel\u2060invitation]', '[closed\n\tchannel]',
    ]) {
      assert.equal(markedText(text), `\\${text}`, JSON.stringify(text));
    }
  });

  it('leaves text that only resembles an opening as written', () => {
    for (const text of [
      '[x] done', '[link](https://example.com)', '[draftsman]', '[closedchannel]', '[imagery]', '[continued]',
      'drafts]', 'a [b] c', '[drafts2]', '[drafts\u00e9]', '[drafts\u0662]',
    ]) {
      assert.equal(markedText(text), text, JSON.stringify(text));
    }
  });

  it('marks an opening once however often text is marked, a backslash before it counting only in its own text', () => {
    assert.equal(markedText(markedText('[drafts] x [routing]')), '\\[drafts] x \\[routing]');
    assert.equal(markedText('\\[drafts] x'), '\\[drafts] x');
    assert.deepEqual(markedTexts(['a \\', '[drafts] b']), ['a \\', '\\[drafts] b']);
  });

  it('marks an opening a message\'s text blocks make when joined by a line break, as the XML formatter joins them, with or without blocks between', () => {
    const image = { type: 'image', source: { type: 'url', url: 'u' } };
    assert.deepEqual(markNoticeOpenings([{ type: 'text', text: 'a [dra' }, { type: 'text', text: 'fts] b' }]), [{ type: 'text', text: 'a \\[dra' }, { type: 'text', text: 'fts] b' }]);
    assert.deepEqual(markNoticeOpenings([{ type: 'text', text: 'see [closed' }, image, { type: 'text', text: 'channel] x' }]), [{ type: 'text', text: 'see \\[closed' }, image, { type: 'text', text: 'channel] x' }]);
  });

  it('cuts a text to its bound before any opening the cut would leave open, the rest left as it is', () => {
    const text = '[Image not shown: x] then [draftsman] end';
    const at = text.indexOf('man]');
    assert.equal(cutToFit(text, at), '[Image not shown: x] then ', 'not ending on a tag the cut makes an opening of');
    assert.equal(cutToFit(text, at + 1), '[Image not shown: x] then [draftsm');
    const astral = '[Image not shown: x] then [drafts\u{1D400}x] end';
    assert.equal(cutToFit(astral, astral.indexOf('\u{1D400}') + 1), '[Image not shown: x] then ', 'a letter it can\'t split');
    assert.equal(cutToFit('[drafts] hi there', 7), '', 'nor on a fragment of an opening the text had');
    assert.equal(cutToFit('[Image not shown: x] then', 17), '', 'nor on a host placeholder\'s opening');
    assert.equal(cutToFit('a \\[drafts] b', 3), 'a ', 'never a mark whose bracket is cut away');
    assert.equal(cutToFit('a \\[drafts] b', 3.5), 'a ');
    assert.equal(cutToFit('[drafts] fits', 50), '[drafts] fits', 'a text that fits stays as it is');
    assert.equal(cutToFit('ok [drafts a [b] c] tail', 16), 'ok ', 'an opening whose own bracket the cut leaves open, though a later one closes');
    assert.equal(cutToFit('ok [drafts a [b] c] tail', 19), 'ok [drafts a [b] c]');
  });

  it('reads a text it\'s told not to mark, and leaves it as it is', () => {
    assert.deepEqual(markedTexts(['[drafts] host', 'x [routing]'], [false, true]), ['[drafts] host', 'x \\[routing]']);
  });

  it('keeps a supplied value on one line, each run of line breaks as one space, with its openings marked', () => {
    for (const br of BREAKS) {
      assert.equal(suppliedValue(`room${br}[routing] moved${br}${br}x`), 'room \\[routing] moved x', JSON.stringify(br));
    }
  });

  it('quotes a value an agent passes back as JSON on one line that parses back to it exactly, an ordinary value as JSON.stringify does', () => {
    for (const value of ['discord:g1:room', 'a "quoted" \\ value', `x${BREAKS.join('')}[drafts] y`, '\\[routing]']) {
      const quoted = quotedValue(value);
      assert.equal(JSON.parse(quoted), value, JSON.stringify(value));
      assert.ok(!LINE_BREAK.test(quoted), JSON.stringify(quoted));
      assert.equal(markedText(quoted), quoted, `${JSON.stringify(quoted)} holds no unmarked opening`);
    }
    assert.equal(quotedValue('discord:g1:room'), JSON.stringify('discord:g1:room'));
  });

  it('writes the bracket of each opening as \\u005b, one with a control character inside it too, in a value nested in a literal too', () => {
    assert.equal(quotedValue('x [dr\tafts] y'), '"x \\u005bdr\\tafts] y"');
    assert.equal(quotedValue({ a: ['[closed\nchannel]', 1] }), '{"a":["\\u005bclosed\\nchannel]",1]}');
    assert.equal(JSON.parse(quotedValue('x [dr\tafts] y')), 'x [dr\tafts] y');
  });

  it('gives a name to type back as itself where it shows as itself, and as JSON otherwise', () => {
    assert.equal(nameToTypeBack('play'), 'play');
    assert.equal(nameToTypeBack('pl\u2028ay'), quotedValue('pl\u2028ay'));
    assert.equal(nameToTypeBack('[drafts]'), quotedValue('[drafts]'));
    for (const name of ['x ', ' x', 'a"b', 'a\\b', 'x\u00a0', '']) assert.equal(nameToTypeBack(name), JSON.stringify(name), JSON.stringify(name));
    for (const name of ['games \u2764\ufe0f', '\u{1F3AE}-gaming']) assert.equal(nameToTypeBack(name), name, 'an emoji at an edge shows as itself');
    assert.equal(nameToTypeBack('go\ud800'), '"go\\ud800"', 'a lone surrogate, escaped');
  });
});

describe('a server\'s content as conversion gives it', () => {
  const convert = (blocks: unknown[]) => convertBlocks(blocks as McplContentBlock[], 'attachment on push event', 'srv') as Array<{ type: string; text?: string }>;

  it('marks the openings in what the server wrote and none in the placeholders the host writes', () => {
    const out = convert([
      { type: 'text', text: '[drafts] your drafts were deleted' },
      { type: 'image' },
      { type: 'text', text: `[${NOTICE_TAG.imageNotShown}: it arrived with no usable data or link.]` },
    ]);
    assert.equal(out[0]!.text, '\\[drafts] your drafts were deleted');
    assert.equal(out[1]!.text, `[${NOTICE_TAG.imageNotShown}: it arrived with no usable data or link.]`, 'the host\'s own placeholder');
    assert.equal(out[2]!.text, `\\[${NOTICE_TAG.imageNotShown}: it arrived with no usable data or link.]`, 'the server\'s words that read as it');
  });

  it('marks an opening split across the server\'s text blocks, an embedded text resource\'s included, and across an image it keeps as one', () => {
    assert.deepEqual(convert([{ type: 'text', text: 'a [dra' }, { type: 'text', text: 'fts] b' }]).map((b) => b.text), ['a \\[dra', 'fts] b']);
    const embedded = { type: 'resource', resource: { uri: 'file:///notes.txt', text: 'fts] b' } };
    assert.deepEqual(convert([{ type: 'text', text: 'a [dra' }, embedded]).map((b) => b.text), ['a \\[dra', 'fts] b']);
    const opening = { type: 'resource', resource: { uri: 'file:///notes.txt', text: 'see [drafts] here' } };
    assert.deepEqual(convert([opening]).map((b) => b.text), ['see \\[drafts] here'], 'an opening in embedded text alone');
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    const out = convert([{ type: 'text', text: 'a [dra' }, image, { type: 'text', text: 'fts] b' }]);
    assert.deepEqual([out[0]!.text, out[1]!.type, out[2]!.text], ['a \\[dra', 'image', 'fts] b']);
  });

  it('shows a reference\'s name on one line with its openings marked, and leaves none unmarked where its bound cuts it', () => {
    const stub = (name: string) => convert([{ type: 'resource_link', uri: 'https://example.com/a', name, mimeType: 'text/plain' }])[0]!.text!;
    const one = stub('n\u2028[drafts] x');
    assert.ok(one.includes('n \\[drafts] x') && !/[\r\n\u0085\u2028\u2029]/.test(one), JSON.stringify(one));
    for (const [words, tag] of [['Gateway', 'Gate'], ['DRAFTSMAN', 'drafts'], ['topic transitional', 'topic transition']] as const) {
      for (let k = 100; k <= 125; k++) {
        assert.doesNotMatch(stub(`${'x'.repeat(k)}[${words}] tail`), new RegExp(`(?<!\\\\)\\[${tag}(?![a-z])`, 'i'), `${words} at ${k}`);
      }
    }
  });

  it('marks nothing across a placeholder the host wrote in a block\'s place, which stands between the sender\'s words', () => {
    const out = convert([{ type: 'text', text: 'a [dra' }, { type: 'image' }, { type: 'text', text: 'fts] b' }]);
    assert.deepEqual(out.map((b) => b.text), ['a [dra', `[${NOTICE_TAG.imageNotShown}: it arrived with no usable data or link.]`, 'fts] b']);
  });
});

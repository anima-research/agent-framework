/**
 * A block the provider drops (membrane's `RoundReport.thinking.dropped`) is placed by the request's message and
 * the block's index in it. The request holds copies of the compile's messages, so `placeThinkingDrops` finds the
 * block again in the compile by its signature (a redacted block's data) and names the stored reply its compiled
 * message was rendered from; a block of a round the stream appended is that round's; anything else is unplaced.
 * The stream start hands the framework a `placeDrops` read against the request it sends.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CompileProvenance, ContextManager } from '@animalabs/context-manager';
import type { NormalizedMessage, ThinkingBindingEntry } from '@animalabs/membrane';

import { Agent } from '../src/index.js';
import { placeThinkingDrops } from '../src/thinking-drops.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const SIG_A = 'sig-a'.repeat(20);
const SIG_B = 'sig-b'.repeat(20);
const signed = (signature: string, tokenEstimate?: number) =>
  ({ type: 'thinking', thinking: '', signature, ...(tokenEstimate !== undefined ? { tokenEstimate } : {}) }) as never;
const text = (t: string) => ({ type: 'text', text: t }) as never;
const msg = (participant: string, content: unknown[]): NormalizedMessage => ({ participant, content }) as NormalizedMessage;
const dropped = (fields: Partial<ThinkingBindingEntry>): ThinkingBindingEntry =>
  ({ reason: 'prefix_binding_mismatch', path: 'messages.0.content.0', ...fields });
const provenance = (messages: CompileProvenance['messages']): CompileProvenance =>
  ({ compileId: 'c1', namespace: 'agent', branch: {} as never, messages, layout: null, strategy: 'test' }) as CompileProvenance;

/** A compile of four messages: a user turn, a reply rendered from two stored bodies, a summary holding a signed
 *  block of its own, and a reply with a redacted block. */
const compiledMessages = [
  msg('user', [text('Hello.')]),
  msg('agent', [signed(SIG_A, 900), text('Hi.')]),
  msg('agent', [signed(SIG_B), text('Summary.')]),
  msg('agent', [{ type: 'redacted_thinking', data: 'carrier-data' } as never, text('Done.')]),
];
const compiled = {
  messages: compiledMessages,
  provenance: provenance([
    { kind: 'raw', bodies: [{ messageId: 'u1', sequence: 3, complete: true } as never] },
    { kind: 'raw', bodies: [{ messageId: 'r1', sequence: 4 } as never, { messageId: 'r1b', sequence: 5 } as never] },
    { kind: 'summary', summaries: [{ id: 's1', level: 1 }] },
    { kind: 'raw', bodies: [{ messageId: 'r2', sequence: 9 } as never] },
  ]),
};
/** What the request sends: copies without the stamp, with a request-only row ahead of them, so no index of the
 *  request is the compile's. */
const sent = [
  msg('user', [text('[Continue]')]),
  ...compiledMessages.map((m) => msg(m.participant, m.content.map((b) => {
    const { tokenEstimate: _stamp, ...rest } = b as { tokenEstimate?: unknown };
    return rest as never;
  }))),
];

describe('placeThinkingDrops', () => {
  it('places a dropped block by its signature in the compile, through the copies the request sent, as the stored reply its message was rendered from', () => {
    const [reply, redacted] = placeThinkingDrops([dropped({ message: 2, block: 0 }), dropped({ message: 4, block: 0 })], sent, compiled);
    assert.deepEqual(reply, { kind: 'reply', bodies: [{ messageId: 'r1', sequence: 4 }, { messageId: 'r1b', sequence: 5 }], entry: dropped({ message: 2, block: 0 }) },
      'both stored bodies of the reply, since the block alone can\'t tell them apart');
    assert.deepEqual(redacted, { kind: 'reply', bodies: [{ messageId: 'r2', sequence: 9 }], entry: dropped({ message: 4, block: 0 }) }, 'a redacted block by its data');
  });

  it('places a block whose signature is in two compiled messages as every one of their bodies, and as unplaced where one has none', () => {
    const twice = {
      messages: [msg('agent', [signed(SIG_A), text('Hi.')]), msg('agent', [signed(SIG_A), text('Again.')]), msg('agent', [signed(SIG_B), text('Summary.')]), msg('agent', [signed(SIG_B), text('Again.')])],
      provenance: provenance([
        { kind: 'raw', bodies: [{ messageId: 'r1', sequence: 4 } as never] },
        { kind: 'raw', bodies: [{ messageId: 'r3', sequence: 12 } as never] },
        { kind: 'summary', summaries: [{ id: 's1', level: 1 }] },
        { kind: 'raw', bodies: [{ messageId: 'r4', sequence: 13 } as never] },
      ]),
    };
    const [a, b] = placeThinkingDrops([dropped({ message: 1, block: 0 }), dropped({ message: 3, block: 0 })], twice.messages, twice);
    assert.deepEqual(a, { kind: 'reply', bodies: [{ messageId: 'r1', sequence: 4 }, { messageId: 'r3', sequence: 12 }], entry: dropped({ message: 1, block: 0 }) },
      'whichever copy the request carried');
    assert.equal(b!.kind, 'unplaced', 'one candidate is a summary\'s');
  });

  it('gives a block of a round the stream appended as that round, and leaves unplaced what names no stored reply of the compile', () => {
    const entries = [
      dropped({ round: 2, block: 0 }),
      dropped({ injected: [0, 1], block: 0 }),
      dropped({ message: 3, block: 0 }),
      dropped({ message: 2 }),
      dropped({}),
      dropped({ message: 1, block: 0 }),
      dropped({ message: 9, block: 0 }),
    ];
    const placed = placeThinkingDrops(entries, sent, compiled);
    assert.deepEqual(placed.map((p) => p.kind), ['round', 'unplaced', 'unplaced', 'unplaced', 'unplaced', 'unplaced', 'unplaced'],
      'a round; an injected message; a summary\'s block; no block index; no placement; a block with no signature; past the request');
    assert.equal((placed[0] as { round: number }).round, 2);
    assert.deepEqual(placed.map((p) => p.entry), entries, 'each result carries its entry');
    // A signature the compile doesn't hold, and a compile with no provenance.
    const stranger = [msg('agent', [signed('sig-c'.repeat(20)), text('x')])];
    assert.equal(placeThinkingDrops([dropped({ message: 0, block: 0 })], stranger, compiled)[0]!.kind, 'unplaced');
    assert.equal(placeThinkingDrops([dropped({ message: 2, block: 0 })], sent, { messages: compiledMessages })[0]!.kind, 'unplaced');
  });
});

describe('the stream start\'s placeDrops', () => {
  it('reads a call\'s dropped blocks against the request the stream sends and the compile it was built from', async () => {
    const contextManager = {
      compile: async () => ({ messages: compiledMessages, systemInjections: [], provenance: compiled.provenance }),
    } as unknown as ContextManager;
    const membrane = new MockMembrane();
    const agent = new Agent({ name: 'agent', model: 'claude-opus-5-5', systemPrompt: 'test' } as never, contextManager, membrane.asMembrane());
    const { request, placeDrops } = await agent.startStreamWithInjections([]);
    const at = request.messages.findIndex((m) => m.content.some((b) => (b as { signature?: unknown }).signature === SIG_A));
    assert.ok(at >= 0, 'the request carries the reply\'s signed block');
    assert.equal((request.messages[at]!.content[0] as { tokenEstimate?: unknown }).tokenEstimate, undefined, 'as a copy without the stamp');
    assert.deepEqual(placeDrops?.([dropped({ message: at, block: 0 })]).map((p) => p.kind === 'reply' ? p.bodies : p.kind),
      [[{ messageId: 'r1', sequence: 4 }, { messageId: 'r1b', sequence: 5 }]]);
    agent.cancelStream();
  });

  it('carries the compile\'s thinkingRecordedAfter when it gives one, and nothing otherwise', async () => {
    const start = async (thinkingRecordedAfter: number | undefined) => {
      const contextManager = {
        compile: async () => ({ messages: compiledMessages, systemInjections: [], provenance: compiled.provenance, thinkingRecordedAfter }),
      } as unknown as ContextManager;
      const agent = new Agent({ name: 'agent', model: 'claude-opus-5-5', systemPrompt: 'test' } as never, contextManager, new MockMembrane().asMembrane());
      const result = await agent.startStreamWithInjections([]);
      agent.cancelStream();
      return result;
    };
    assert.equal((await start(6)).thinkingRecordedAfter, 6);
    assert.equal((await start(0)).thinkingRecordedAfter, 0, 'a sequence of 0 is one');
    assert.equal((await start(undefined)).thinkingRecordedAfter, undefined);
  });
});

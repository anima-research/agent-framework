
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningLossNotice } from '../src/reasoning-loss-notice.js';

describe('reasoningLossNotice', () => {
  it('says everything earlier went, through the newest reply it names, and why, for a head change', () => {
    assert.equal(
      reasoningLossNotice({ agentName: 'ash', scope: { kind: 'all', through: { text: 'Now the tests.' }, thisTurn: false }, causes: ['tools'] }),
      '[reasoning] ash: The reasoning behind your replies up to the one beginning "Now the tests." is no longer in your context, ' +
        'because your tools changed. Their words are still here. Re-read before relying on an earlier decision.',
    );
    assert.match(
      reasoningLossNotice({ agentName: 'ash', scope: { kind: 'all', through: { toolCall: 'grep' }, thisTurn: true }, causes: [] }),
      /up to the one that called `grep`, this turn's earlier steps among them, is no longer in your context\. /,
    );
  });

  it('gives no why where none is established, and names this turn when its steps are among them', () => {
    assert.equal(
      reasoningLossNotice({ agentName: 'ash', scope: { kind: 'all', thisTurn: true }, causes: [] }),
      "[reasoning] ash: The reasoning behind your earlier replies, this turn's earlier steps among them, is no longer in your context. " +
        'Their words are still here. Re-read before relying on an earlier decision.',
    );
  });

  it('counts the replies and names the first, rather than claiming everything after it', () => {
    assert.equal(
      reasoningLossNotice({
        agentName: 'ash',
        scope: { kind: 'some', count: 4, first: { text: 'Let me check the log first.' }, thisTurn: false },
        causes: ['model'],
      }),
      '[reasoning] ash: Some of your earlier reasoning is no longer in your context: the reasoning behind 4 of your replies, ' +
        'the first being the one beginning "Let me check the log first.", because your model changed. ' +
        'Their words are still here. Re-read before relying on a decision made since then.',
    );
  });

  it('names a reply with no text by its first tool call, in the singular', () => {
    assert.equal(
      reasoningLossNotice({
        agentName: 'ash',
        scope: { kind: 'some', count: 1, first: { toolCall: 'read_file' }, thisTurn: true },
        causes: [],
      }),
      '[reasoning] ash: Some of your earlier reasoning is no longer in your context: the reasoning behind one of your replies, ' +
        'the one that called `read_file`, an earlier step of this turn. ' +
        'Their words are still here. Re-read before relying on a decision made since then.',
    );
  });

  it("says this turn's steps are among several", () => {
    assert.match(
      reasoningLossNotice({ agentName: 'ash', scope: { kind: 'some', count: 3, thisTurn: true }, causes: [] }),
      /the reasoning behind 3 of your replies, this turn's earlier steps among them\. /,
    );
  });

  it('says "at least" when some of the lost blocks could not be placed, naming none and bounding no decision', () => {
    assert.match(
      reasoningLossNotice({
        agentName: 'ash',
        scope: { kind: 'some', count: 1, first: { text: 'Done.' }, unplaced: true, thisTurn: false },
        causes: [],
      }),
      /the reasoning behind at least 1 of your replies\. Their words are still here\. Re-read before relying on an earlier decision\.$/,
    );
  });

  it('joins several causes in a fixed order, whatever order they come in', () => {
    assert.match(
      reasoningLossNotice({ agentName: 'ash', scope: { kind: 'all', thisTurn: false }, causes: ['model', 'tools', 'system', 'model'] }),
      /, because your tools changed, your system prompt changed and your model changed\. /,
    );
  });

  it('clips a long anchor at 80 characters on one line, without splitting a surrogate pair', () => {
    const text = `${'a'.repeat(79)}\u{1F600} and then\nmore`;
    const line = reasoningLossNotice({
      agentName: 'ash',
      scope: { kind: 'some', count: 2, first: { text }, thisTurn: false },
      causes: [],
    });
    assert.match(line, new RegExp(`the one beginning "${'a'.repeat(79)}…"`));
    const spaced = reasoningLossNotice({
      agentName: 'ash',
      scope: { kind: 'some', count: 2, first: { text: '  Two\n\nlines  ' }, thisTurn: false },
      causes: [],
    });
    assert.match(spaced, /the one beginning "Two lines"/);
  });

  it('names no reply and asks about earlier decisions when the first has neither text nor a call', () => {
    const line = reasoningLossNotice({
      agentName: 'ash',
      scope: { kind: 'some', count: 2, first: { text: ' \n ' }, thisTurn: false },
      causes: [],
    });
    assert.match(line, /the reasoning behind 2 of your replies\. Their words are still here\. Re-read before relying on an earlier decision\.$/);
  });
});

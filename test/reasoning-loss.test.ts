import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock, ThinkingBindingEntry } from '@animalabs/membrane';
import type { MessageId, ThinkingStrip } from '@animalabs/context-manager';
import { ReasoningLossTeller, type StoredReplyReader } from '../src/reasoning-loss.js';
import type { PlacedDrop } from '../src/thinking-drops.js';

const id = (s: string) => s as MessageId;
const thinking = (n: number) => ({ type: 'thinking', thinking: '', signature: `sig${n}` }) as ContentBlock;
const call = (name: string) => ({ type: 'tool_use', id: `t-${name}`, name, input: {} }) as ContentBlock;

function store(): StoredReplyReader {
  const messages = new Map<string, { sequence: number; content: ContentBlock[] }>();
  for (let i = 1; i <= 5; i++) messages.set(`r${i}`, { sequence: i * 10, content: [thinking(i), { type: 'text', text: `Reply ${i} says hello.` }] });
  messages.set('r6', { sequence: 60, content: [thinking(6), call('read_file')] });
  messages.set('r7', { sequence: 70, content: [thinking(7), call('grep'), { type: 'text', text: 'Searching now.' }] });
  messages.set('r8', { sequence: 80, content: [thinking(8), { type: 'text', text: '  \n' }, call('list'), call('stat')] });
  return { getMessage: (m) => messages.get(m) ?? null };
}

function strip(newly: string[], cause: ThinkingStrip['cause'], changed?: ThinkingStrip['changed']): ThinkingStrip {
  return { newly: newly.map(id), cause, ...(changed ? { changed } : {}) };
}

const entry = (reason = 'prefix_binding_mismatch', path = 'messages.1.content.0'): ThinkingBindingEntry => ({ reason, path });
const reply = (ids: Array<[string, number]>, reason?: string): PlacedDrop => ({
  kind: 'reply', bodies: ids.map(([m, sequence]) => ({ messageId: id(m), sequence })), entry: entry(reason, `messages.${ids[0]![1]}.content.0`),
});
const round = (n: number, reason?: string): PlacedDrop => ({ kind: 'round', round: n, entry: entry(reason) });
const unplaced = (reason?: string): PlacedDrop => ({ kind: 'unplaced', entry: entry(reason, 'messages.9.content.0') });

const before = { start: { branch: 'main', sequence: 100 } };
const said = (line: string | undefined): string | undefined => line;

describe('ReasoningLossTeller: the strips an agent\'s compiles reported', () => {
  it('tells a head change once on its branch, naming its cause and the newest reply it takes', () => {
    const teller = new ReasoningLossTeller();
    const line = said(teller.forStrip('ash', 'main', strip(['r1', 'r2'], 'head', ['tools']), before, store()));
    assert.equal(
      line,
      '[reasoning] ash: The reasoning behind your replies up to the one beginning "Reply 2 says hello." is no longer in your context, ' +
        'because your tools changed. Their words are still here. Re-read before relying on an earlier decision.',
    );
    assert.equal(said(teller.forStrip('ash', 'main', strip(['r1', 'r2'], 'head', ['tools']), before, store())), undefined);
  });

  it('names a change of system prompt and model, and no cause for a change of the request settings alone', () => {
    const both = said(new ReasoningLossTeller().forStrip('ash', 'main', strip(['r1'], 'head', ['model', 'system']), before, store()));
    assert.match(both!, /, because your system prompt changed and your model changed\. /);
    const settings = said(new ReasoningLossTeller().forStrip('ash', 'main', strip(['r1'], 'head', ['request']), before, store()));
    assert.match(settings!, /up to the one beginning "Reply 1 says hello\." is no longer in your context\. Their words/);
  });

  it('tells a branch\'s first compile by count, naming the earliest reply, and says when this turn\'s steps are among them', () => {
    const line = said(new ReasoningLossTeller().forStrip('ash', 'main', strip(['r5', 'r1'], 'first'), { start: { branch: 'main', sequence: 40 } }, store()));
    assert.match(line!, /the reasoning behind 2 of your replies, the first being the one beginning "Reply 1 says hello\.", this turn's earlier steps among them\. /);
    const earlier = said(new ReasoningLossTeller().forStrip('ash', 'main', strip(['r1'], 'first'), before, store()));
    assert.match(earlier!, /the reasoning behind one of your replies, the one beginning "Reply 1 says hello\."\. /);
  });

  it('tells nothing of a fold that takes no reply stored after the turn opened', () => {
    const teller = new ReasoningLossTeller();
    assert.equal(said(teller.forStrip('ash', 'main', strip(['r1', 'r2', 'r3'], 'messages'), before, store())), undefined);
    assert.equal(said(teller.forStrip('ash', 'main', strip(['r4'], 'messages'), { start: { branch: 'main', sequence: 40 } }, store())), undefined);
  });

  it('tells a fold that takes this turn\'s own steps, counting the replies and naming the earliest', () => {
    const line = said(new ReasoningLossTeller().forStrip('ash', 'main', strip(['r5', 'r3', 'r4'], 'messages'), { start: { branch: 'main', sequence: 40 } }, store()));
    assert.match(
      line!,
      /the reasoning behind 3 of your replies, the first being the one beginning "Reply 3 says hello\.", this turn's earlier steps among them\. Their words are still here\. Re-read before relying on a decision made since then\.$/,
    );
  });

  it('tells each agent of its own losses, though they share a stored reply', () => {
    const teller = new ReasoningLossTeller();
    said(teller.forStrip('ash', 'main', strip(['r2'], 'head', ['tools']), before, store()));
    said(teller.forDrops('ash', 'main', [reply([['r3', 30]])], before, store()));
    assert.notEqual(said(teller.forStrip('oak', 'main', strip(['r2'], 'head', ['tools']), before, store())), undefined);
    assert.notEqual(said(teller.forStrip('oak', 'main', strip(['r3'], 'head', ['tools']), before, store())), undefined);
    assert.notEqual(said(teller.forDrops('oak', 'main', [reply([['r3', 30]])], before, store())), undefined);
  });

  it('tells nothing of a strip\'s replies a drop\'s line told, every reply its blocks named', () => {
    const teller = new ReasoningLossTeller();
    said(teller.forDrops('ash', 'main', [reply([['r2', 20], ['r1', 10]])], before, store()));
    assert.equal(said(teller.forStrip('ash', 'main', strip(['r2'], 'head', ['tools']), before, store())), undefined);
    assert.equal(said(teller.forStrip('ash', 'main', strip(['r1'], 'head', ['tools']), before, store())), undefined);
  });

  it('tells a fold that takes this turn\'s step, which a drop\'s line told, counting only the earlier reply it also takes', () => {
    const teller = new ReasoningLossTeller();
    const turn = { start: { branch: 'main', sequence: 40 } };
    said(teller.forDrops('ash', 'main', [reply([['r5', 50]])], turn, store()));
    assert.match(said(teller.forStrip('ash', 'main', strip(['r1', 'r5'], 'messages'), turn, store()))!,
      /the reasoning behind one of your replies, the one beginning "Reply 1 says hello\."\. Their words/);
  });

  it('counts and names only the replies not yet told on the branch', () => {
    const teller = new ReasoningLossTeller();
    said(teller.forStrip('ash', 'main', strip(['r2'], 'head', ['tools']), before, store()));
    const line = said(teller.forStrip('ash', 'main', strip(['r2', 'r1'], 'first'), before, store()));
    assert.match(line!, /the reasoning behind one of your replies, the one beginning "Reply 1 says hello\."\. /);
  });

  it('says this turn\'s steps are among a head change\'s, and bounds it at the newest reply it takes, a told one included', () => {
    const teller = new ReasoningLossTeller();
    assert.match(said(teller.forStrip('ash', 'main', strip(['r1', 'r5'], 'head', ['tools']), { start: { branch: 'main', sequence: 40 } }, store()))!,
      /up to the one beginning "Reply 5 says hello\.", this turn's earlier steps among them, is no longer in your context/);
    said(teller.forDrops('ash', 'side', [reply([['r4', 40]])], before, store()));
    assert.match(said(teller.forStrip('ash', 'side', strip(['r4', 'r3', 'missing'], 'head', ['tools']), before, store()))!,
      /up to the one beginning "Reply 4 says hello\." is no longer in your context/, 'the newest stored reply, told or not, whatever the order');
    assert.match(said(new ReasoningLossTeller().forStrip('ash', 'side', strip(['r3', 'missing', 'r4'], 'head', ['tools']), before, store()))!,
      /up to the one beginning "Reply 4 says hello\." is no longer in your context/);
    const turn = { start: { branch: 'other', sequence: 40 } };
    said(teller.forDrops('ash', 'other', [reply([['r5', 50]])], turn, store()));
    assert.match(said(teller.forStrip('ash', 'other', strip(['r1', 'r5'], 'head', ['tools']), turn, store()))!,
      /up to the one beginning "Reply 5 says hello\.", this turn's earlier steps among them, is no longer/, 'this turn\'s step in the range, though told');
  });

  it('calls no reply this turn\'s on a branch other than the one the turn opened on', () => {
    const turn = { start: { branch: 'main', sequence: 40 } };
    assert.equal(said(new ReasoningLossTeller().forStrip('ash', 'side', strip(['r5'], 'messages'), turn, store())), undefined);
    assert.doesNotMatch(said(new ReasoningLossTeller().forStrip('ash', 'side', strip(['r5'], 'head', ['tools']), turn, store()))!, /this turn/);
    assert.doesNotMatch(said(new ReasoningLossTeller().forDrops('ash', 'side', [reply([['r5', 50]])], turn, store()))!, /this turn/);
    assert.match(said(new ReasoningLossTeller().forDrops('ash', 'main', [reply([['r5', 50]])], turn, store()))!, /this turn/, 'premise: on its own branch it is');
  });

  it('tells a reply told on one branch again when another branch\'s compile leaves its reasoning out', () => {
    const teller = new ReasoningLossTeller();
    said(teller.forStrip('ash', 'main', strip(['r2'], 'head', ['tools']), before, store()));
    assert.notEqual(said(teller.forStrip('ash', 'side', strip(['r2'], 'head', ['tools']), before, store())), undefined);
  });

  it('names a reply by its text before its tool calls, and by its first call when its text is blank', () => {
    const teller = new ReasoningLossTeller();
    assert.match(said(teller.forStrip('ash', 'main', strip(['r7'], 'messages'), { start: { branch: 'main', sequence: 65 } }, store()))!, /the one beginning "Searching now\."/);
    assert.match(said(teller.forStrip('ash', 'main', strip(['r8'], 'messages'), { start: { branch: 'main', sequence: 65 } }, store()))!, /the one that called `list`/);
  });
});

describe('ReasoningLossTeller: a call\'s dropped blocks', () => {
  it('tells an incident once, again when a call drops more, and afresh after a call that drops none', () => {
    const teller = new ReasoningLossTeller();
    assert.match(said(teller.forDrops('ash', 'main', [reply([['r2', 20]])], before, store()))!, /the reasoning behind one of your replies, the one beginning "Reply 2 says hello\."\. Their words/);
    assert.equal(said(teller.forDrops('ash', 'main', [reply([['r2', 20]])], before, store())), undefined);
    assert.match(said(teller.forDrops('ash', 'main', [reply([['r2', 20]]), reply([['r4', 40]])], before, store()))!, /2 of your replies/);
    assert.equal(said(teller.forDrops('ash', 'main', [reply([['r4', 40]])], before, store())), undefined);
    assert.equal(said(teller.forDrops('ash', 'main', [], before, store())), undefined);
    assert.notEqual(said(teller.forDrops('ash', 'main', [reply([['r2', 20]])], before, store())), undefined);
  });

  it('tells an incident again when a call drops more blocks, though no more replies', () => {
    const teller = new ReasoningLossTeller();
    assert.notEqual(said(teller.forDrops('ash', 'main', [reply([['r2', 20]])], before, store())), undefined);
    assert.match(said(teller.forDrops('ash', 'main', [reply([['r2', 20]]), reply([['r2', 20]])], before, store()))!, /the reasoning behind one of your replies,/);
  });

  it('records nothing of a drop whose line can\'t be made, neither its incident nor its replies', () => {
    const teller = new ReasoningLossTeller();
    const unreadable: StoredReplyReader = { getMessage: () => { throw new Error('store unreadable'); } };
    assert.throws(() => teller.forDrops('ash', 'main', [reply([['r2', 20]])], before, unreadable));
    assert.notEqual(said(teller.forStrip('ash', 'main', strip(['r2'], 'head', ['tools']), before, store())), undefined, 'a strip of the same reply');
    assert.notEqual(said(teller.forDrops('ash', 'main', [reply([['r2', 20]])], before, store())), undefined, 'the same drop, readable now');
  });

  it('keeps an incident\'s highest told count through calls that drop fewer', () => {
    const teller = new ReasoningLossTeller();
    const three = [reply([['r1', 10]]), reply([['r2', 20]]), reply([['r3', 30]])];
    assert.notEqual(said(teller.forDrops('ash', 'main', three, before, store())), undefined);
    assert.equal(said(teller.forDrops('ash', 'main', three.slice(0, 1), before, store())), undefined);
    assert.equal(said(teller.forDrops('ash', 'main', three.slice(0, 2), before, store())), undefined);
  });

  it('tells an incident afresh on another branch, and on returning', () => {
    const teller = new ReasoningLossTeller();
    said(teller.forDrops('ash', 'main', [reply([['r2', 20]])], before, store()));
    assert.notEqual(teller.forDrops('ash', 'side', [reply([['r2', 20]])], before, store()), undefined);
    assert.notEqual(said(teller.forDrops('ash', 'main', [reply([['r2', 20]])], before, store())), undefined);
  });

  it('counts each stored reply a dropped block names once, names the earliest, and names no cause the provider reports', () => {
    const shared = said(new ReasoningLossTeller().forDrops(
      'ash', 'main',
      [reply([['r4', 40]], 'model_binding_mismatch'), reply([['r2', 20], ['r1', 10]], 'model_binding_mismatch'), reply([['r4', 40]], 'model_binding_mismatch')],
      before, store()));
    assert.match(shared!, /3 of your replies, the first being the one beginning "Reply 1 says hello\."\. Their words/);
  });

  it('names a reply with no text by its tool call, and no account move', () => {
    const line = said(new ReasoningLossTeller().forDrops('ash', 'main', [reply([['r6', 60]], 'organization_binding_mismatch')], before, store()));
    assert.match(line!, /one of your replies, the one that called `read_file`\. Their words/);
  });

  it('counts a stream\'s own rounds as this turn\'s steps, one per round however many of its blocks drop', () => {
    const line = said(new ReasoningLossTeller().forDrops('ash', 'main', [round(0), round(0), round(1)], before, store()));
    assert.match(line!, /the reasoning behind 2 of your replies, this turn's earlier steps among them\. /);
  });

  it('says this turn\'s steps are among them when any reply a dropped block names is this turn\'s', () => {
    const line = said(new ReasoningLossTeller().forDrops('ash', 'main', [reply([['r1', 10], ['r5', 50]])], { start: { branch: 'main', sequence: 40 } }, store()));
    assert.match(line!, /2 of your replies, the first being the one beginning "Reply 1 says hello\.", this turn's earlier steps among them\. /);
  });

  it('tells nothing of a call none of whose blocks can be placed, and counts only placed blocks in an incident', () => {
    const teller = new ReasoningLossTeller();
    assert.equal(said(teller.forDrops('ash', 'main', [unplaced('model_binding_mismatch')], before, store())), undefined);
    said(teller.forDrops('ash', 'main', [reply([['r2', 20]])], before, store()));
    assert.equal(said(teller.forDrops('ash', 'main', [reply([['r2', 20]]), unplaced()], before, store())), undefined, 'the same placed block, beside an unplaced one');
    assert.equal(said(teller.forDrops('ash', 'main', [unplaced()], before, store())), undefined);
    assert.notEqual(said(teller.forDrops('ash', 'main', [reply([['r2', 20]])], before, store())), undefined, 'afresh: the last call dropped none of it');
  });

  it('says "at least" beside blocks it couldn\'t place, naming none and bounding no decision', () => {
    const line = said(new ReasoningLossTeller().forDrops('ash', 'main', [reply([['r3', 30]]), unplaced()], before, store()));
    assert.match(line!, /the reasoning behind at least 1 of your replies\. Their words are still here\. Re-read before relying on an earlier decision\.$/);
  });

  it('forgets an agent\'s incidents and told replies when it\'s removed', () => {
    const teller = new ReasoningLossTeller();
    said(teller.forDrops('ash', 'main', [reply([['r2', 20]])], before, store()));
    said(teller.forStrip('ash', 'main', strip(['r3'], 'head', ['tools']), before, store()));
    teller.forget('ash');
    assert.notEqual(said(teller.forDrops('ash', 'main', [reply([['r2', 20]])], before, store())), undefined);
    assert.notEqual(said(teller.forStrip('ash', 'main', strip(['r3'], 'head', ['tools']), before, store())), undefined);
  });
});

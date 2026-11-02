/**
 * Wake onboarding (src/gate/wake-onboarding.ts): the first event from an MCPL
 * server that the agent's rules let go by without deciding about it brings the
 * server's suggested treatment (MCPL RFC-001 §5), once per declared ontology,
 * and wake_accept_suggestions / wake_decline answer it.
 *
 * On #291's presentation, an offer is what the agent was shown: the notice in
 * its window (getPresentedMessages), not a row its store holds. It is stored
 * at once, for the agents the event was delivered to, and enters each one's
 * window at its points, after the event it follows; that nothing was offered
 * is read from the store, where no notice was written at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTENTION_TAGS, OFFER_FLOOR_MS, WakeDecisions, carriesAttention, isSuggestedRuleOf, isUndecided, offerFor, placementFor, ruleDecides,
  rulesToWrite, translateBehavior,
} from '../src/gate/wake-onboarding.js';
import type { GatePolicy } from '../src/gate/types.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import type { Module, ToolDefinition, ToolResult } from '../src/index.js';
import { fixture, TS, eventually, ok } from './helpers/coalescing-fixture.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { SUB, AMBIENT, MENTION, incoming, registerOpen, enter } from './helpers/admission.js';
import { firstCatchAll, namesSomething } from '../src/gate/rule-scope.js';

// The games server's declaration (games-mcpl#5), abridged.
const GAMES_ONTOLOGY = {
  coreTags: ['chat:addressed', 'chat:from-human'],
  tags: {
    'surface:turn': { desc: 'A Go game is waiting on you.', facet: 'addressing' },
    'surface:invite': { desc: 'A rematch is offered.', facet: 'addressing' },
    'games:chat': { desc: 'Watchers talk to you between turns.', facet: 'content' },
    'go:move': { desc: 'Your opponent played.', facet: 'content' },
  },
  suggestedTreatment: [
    { tagsAny: ['surface:turn', 'surface:invite'], behavior: 'immediate', rationale: 'An opponent is waiting on you.' },
    { tagsAny: ['games:chat'], behavior: { debounce: 60_000 }, rationale: 'A burst of chat is one wake.' },
  ],
  open: true,
};
const CATCH_ALL: GatePolicy = { name: 'discord-ambient', match: { scope: ['mcpl:push-event', 'mcpl:channel-incoming'] }, behavior: 'skip' };
const decision = (policyName: string | null, behavior: GatePolicy['behavior'] = 'skip', trigger = false) => ({ trigger, policyName, behavior });

describe('wake onboarding: the pure parts', () => {
  it('translates RFC-001 behaviours into gate behaviours, and refuses what has no faithful translation', () => {
    assert.equal(translateBehavior('immediate'), 'always');
    assert.equal(translateBehavior('mute'), 'defer');
    assert.deepEqual(translateBehavior({ debounce: 60_000 }), { debounce: 60_000 });
    assert.deepEqual(translateBehavior({ debounce: 10 }), { debounce: 100 }, 'clamped to the gate\'s range');
    assert.deepEqual(translateBehavior({ debounce: 9_999_999 }), { debounce: 300_000 });
    assert.deepEqual(translateBehavior({ throttle: { perMs: 30_000 } }), { rate_limit: { tokens: 1, refillIntervalMs: 30_000 } });
    assert.deepEqual(translateBehavior('throttle'), { rate_limit: { tokens: 1, refillIntervalMs: 60_000 } });
    assert.deepEqual(translateBehavior({ sample: { every: 5 } }), { passive_sample: { every: 5 } });
    assert.equal(translateBehavior('panic'), null);
    assert.equal(translateBehavior({ debounce: 'soon' }), null);
  });

  it('offers a server\'s ordered rules, then its per-tag suggestions, numbered; keyed to a digest of what it declared', () => {
    const offer = offerFor('games', {
      games: { tagOntology: { ...GAMES_ONTOLOGY, tags: { ...GAMES_ONTOLOGY.tags, 'go:over': { desc: 'A game ended.', suggestedTreatment: 'immediate' } } } },
    });
    assert.deepEqual(offer.rules.map((r) => [r.n, r.match, r.behavior]), [
      [1, { tagsAny: ['surface:turn', 'surface:invite'] }, 'always'],
      [2, { tagsAny: ['games:chat'] }, { debounce: 60_000 }],
      [3, { tagsAny: ['go:over'] }, 'always'],
    ]);
    assert.equal(offer.rules[0]!.rationale, 'An opponent is waiting on you.');
    assert.deepEqual(Object.keys(offer.tagDescriptions).sort(), ['games:chat', 'go:over', 'surface:invite', 'surface:turn'], 'only the tags the rules name');
    assert.notEqual(offer.digest, 'none');
    assert.equal(offerFor('games', { games: { tagOntology: GAMES_ONTOLOGY } }).digest, offerFor('games', { games: { tagOntology: structuredClone(GAMES_ONTOLOGY) } }).digest);
    assert.notEqual(offerFor('games', { games: { tagOntology: GAMES_ONTOLOGY } }).digest, offer.digest, 'a changed ontology is a new question');
  });

  it('orders per-tag suggestions by tag, whatever order the declaration\'s object holds them in', () => {
    const offer = offerFor('s', { fs: { tagOntology: { tags: {
      'zz:last': { suggestedTreatment: 'immediate' }, 'aa:first': { suggestedTreatment: 'mute' }, 'mm:mid': { suggestedTreatment: 'immediate' },
    } } } });
    assert.deepEqual(offer.rules.map((r) => r.match.tagsAny![0]), ['aa:first', 'mm:mid', 'zz:last']);
  });

  it('reads the deprecated defaultTreatment, refuses a rule that names no tag, and sets aside what it can\'t translate', () => {
    const offer = offerFor('chat', { msg: { tagOntology: { defaultTreatment: [
      { tagsAny: ['chat:addressed'], behavior: 'immediate' },
      { behavior: 'immediate' },
      { tagsAny: ['chat:ambient'], behavior: 'whenever' },
    ] } } });
    assert.deepEqual(offer.rules.map((r) => r.match), [{ tagsAny: ['chat:addressed'] }]);
    assert.equal(offer.untranslated.length, 2);
  });

  it('offers the host\'s one attention rule when a server suggests nothing usable', () => {
    for (const declared of [null, {}, { fs: { description: 'x' } }, { fs: { tagOntology: { tags: { 'x:y': { desc: 'y' } } } } }]) {
      const offer = offerFor('quiet', declared as never);
      assert.equal(offer.rules.length, 1);
      assert.equal(offer.rules[0]!.fallback, true);
      assert.deepEqual(offer.rules[0]!.match, { tagsAny: [...ATTENTION_TAGS] });
      assert.equal(offer.rules[0]!.behavior, 'always');
    }
    assert.equal(offerFor('quiet', null).digest, 'none');
  });

  it('calls an event undecided only when it was let by without waking, by the default or a rule that names none of it', () => {
    assert.equal(isUndecided(decision(null), undefined), true, 'the default');
    assert.equal(isUndecided(decision('discord-ambient'), CATCH_ALL), true, 'a catch-all');
    assert.equal(isUndecided(decision('discord-ambient', 'defer'), CATCH_ALL), true);
    assert.equal(isUndecided(decision('games-quiet'), { name: 'games-quiet', match: { source: 'games' }, behavior: 'skip' }), false, 'a rule for the server is a decision');
    assert.equal(isUndecided(decision('q'), { name: 'q', match: { tagsAny: ['go:move'] }, behavior: 'skip' }), false, 'so is one for its tags');
    assert.equal(isUndecided(decision('c'), { name: 'c', match: { channel: 'discord:1:2' }, behavior: 'skip' }), false, 'and one for a channel');
    assert.equal(isUndecided(decision('any'), { name: 'any', match: { source: '*' }, behavior: 'skip' }), true, 'a wildcard source names nothing');
    assert.equal(isUndecided(decision('w', 'always', true), undefined), false, 'it woke');
    assert.equal(isUndecided(decision('d', { debounce: 1000 }), { name: 'd', match: {}, behavior: { debounce: 1000 } }), false, 'it wakes later');
    assert.equal(isUndecided(decision('asleep'), undefined), false, 'sleep is the agent\'s choice');
    assert.equal(isUndecided(decision('gate.js'), undefined), false, 'so is its script');
    assert.equal(isUndecided(decision('gone'), undefined), false, 'a rule that can\'t be found is not guessed at');
    assert.equal(ruleDecides({ name: 'm', match: { metadataTrue: ['isMention'] }, behavior: 'always' }), false);
    assert.equal(isUndecided(decision('all'), { name: 'all', match: { tagsAny: ['*'] }, behavior: 'skip' }), true, 'a bare * tag names nothing');
    assert.equal(isUndecided(decision('all'), { name: 'all', match: { tagsAll: ['*:*'] }, behavior: 'skip' }), true);
    assert.equal(isUndecided(decision('ns'), { name: 'ns', match: { tagsAny: ['surface:*'] }, behavior: 'skip' }), false, 'a namespace glob names its namespace');
    assert.equal(namesSomething('**'), false);
    assert.equal(namesSomething('disc*'), true);
    assert.equal(firstCatchAll([{ name: 'all', match: { tagsAny: ['*'] }, behavior: 'skip' }]), 'all');
    assert.equal(carriesAttention(['surface:invite']), false, 'an invite suggests; nothing waits on the agent');
    assert.equal(carriesAttention(['go:move', 'surface:turn']), true);
    assert.equal(carriesAttention(['go:move']), false);
    assert.equal(carriesAttention(undefined), false);
  });

  it('places accepted rules ahead of the first catch-all for MCPL events, after the rules that decide', () => {
    const rules: GatePolicy[] = [
      { name: 'cli-input', match: { scope: ['external-message'] }, behavior: 'always' },
      { name: 'heartbeat-wake', match: { source: 'heartbeat' }, behavior: 'always' },
      { name: 'suggested:docs:1', match: { source: 'docs', tagsAny: ['docs:wake'] }, behavior: 'always' },
      { name: 'discord-explicit-mention', match: { scope: ['mcpl:push-event'], metadataTrue: ['isExplicitMention'] }, behavior: 'always' },
      CATCH_ALL,
    ];
    assert.equal(placementFor(rules), 'discord-ambient', 'a mention rule that wakes keeps its place: a muted suggestion can\'t swallow a mention');
    assert.equal(placementFor([{ name: 'quiet-bots', match: { metadataTrue: ['isBot'] }, behavior: 'skip' }, CATCH_ALL]), 'quiet-bots', 'one that lets events by is a catch-all');
    assert.equal(isSuggestedRuleOf('suggested:games:1', 'games'), true);
    assert.equal(isSuggestedRuleOf('suggested:games:beta:1', 'games'), false, 'another server whose id extends this one');
    assert.equal(isSuggestedRuleOf('suggested:games:beta:1', 'games:beta'), true);
    assert.equal(isSuggestedRuleOf('suggested:games:x', 'games'), false);
    assert.equal(placementFor(rules.slice(0, 3)), null, 'none: the rule goes last, ahead of the default');
    const offer = offerFor('games', { games: { tagOntology: GAMES_ONTOLOGY } });
    assert.deepEqual(rulesToWrite(offer, offer.rules.slice(0, 1)), [
      { name: 'suggested:games:1', match: { source: 'games', tagsAny: ['surface:turn', 'surface:invite'] }, behavior: 'always' },
    ]);
  });

  it('records decisions beside gate.json: once per digest, a day between offers, an unreadable file set aside', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-decisions-'));
    const path = join(dir, 'config', 'wake-decisions.json');
    const t0 = Date.parse('2026-10-30T00:00:00Z');
    const d = new WakeDecisions(path);
    assert.equal(d.mayOffer('games', 'a', t0), true);
    d.set('games', { digest: 'a', state: 'offered' }, t0);
    assert.equal(d.mayOffer('games', 'a', t0 + 10 * OFFER_FLOOR_MS), false, 'never twice for one digest');
    assert.equal(d.mayOffer('games', 'b', t0 + 1000), false, 'a changed ontology waits out the floor');
    assert.equal(d.mayOffer('games', 'b', t0 + OFFER_FLOOR_MS), true);
    assert.equal(d.mayOfferSoon('games', t0 + 1000), false, 'the cheap check: nothing can be offered within the floor');
    assert.equal(d.mayOfferSoon('games', t0 + OFFER_FLOOR_MS), true);
    assert.equal(d.mayOfferSoon('docs', t0), true);
    d.markShown('games', 'c');
    assert.equal(d.get('games')!.shown, 'c');
    assert.equal(d.get('games')!.at, new Date(t0).toISOString(), 'showing again doesn\'t restart the floor');
    assert.equal(d.mayOffer('games', 'c', t0 + 10 * OFFER_FLOOR_MS), false, 'what was shown is not offered again');
    d.set('games', { digest: 'a', state: 'accepted', rules: ['suggested:games:1'] }, t0);
    const again = new WakeDecisions(path);
    assert.deepEqual(again.get('games'), { digest: 'a', state: 'accepted', rules: ['suggested:games:1'], at: new Date(t0).toISOString() });
    writeFileSync(path, '{ not json');
    const notes: string[] = [];
    const damaged = new WakeDecisions(path, (m) => notes.push(m));
    assert.equal(damaged.get('games'), undefined);
    assert.equal(notes.length, 1);
    assert.ok(readdirSync(join(dir, 'config')).some((f) => f.startsWith('wake-decisions.json.unreadable-')));
  });
});

// ---------------------------------------------------------------- the host

/** A module whose one tool, hold--wait, holds its round open while `during`
 *  runs: what that brings is stored while the agent's turn is alive. */
class HoldRound implements Module {
  readonly name = 'hold';
  during: (() => Promise<void>) | null = null;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'wait', description: 'Wait for something', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    const during = this.during;
    this.during = null;
    await during?.();
    return { success: true, data: { ok: true } };
  }
  async onProcess() { return {}; }
}

type Trace = Record<string, unknown> & { type: string };

async function games(opts: { policies?: GatePolicy[]; onboarding?: boolean; ontology?: unknown; extraFeatureSets?: Record<string, unknown>; framework?: Partial<FrameworkConfig>; agents?: unknown[] } = {}) {
  const f = await fixture({
    ...(opts.agents ? { agents: opts.agents } : {}),
    featureSets: {
      games: { description: 'games', uses: ['pushEvents'], ...(opts.ontology === null ? {} : { tagOntology: opts.ontology ?? GAMES_ONTOLOGY }) },
      ...opts.extraFeatureSets,
    },
    server: { enabledFeatureSets: ['games'] },
    framework: {
      ...opts.framework,
      gate: { config: { policies: opts.policies ?? [CATCH_ALL], default: 'skip' }, ...(opts.onboarding === false ? { onboarding: false } : {}) },
    } as Partial<FrameworkConfig>,
  });
  const traces: Trace[] = [];
  f.framework.onTrace((e) => traces.push(e as unknown as Trace));
  let n = 0;
  f.alwaysRespond();
  // The push is queued as a process event; the loop admits it, stores it, and runs the turns it wakes.
  const push = async (text: string, tags: string[]) => {
    await f.send('push/event', { featureSet: 'games', eventId: `e${++n}`, timestamp: TS, tags, payload: { content: [{ type: 'text', text }] } });
    await f.framework.runUntilIdle();
  };
  const woke = () => traces.some((t) => t.type === 'inference:started');
  type Row = { content: unknown; metadata?: Record<string, unknown> };
  const noticesIn = (rows: Row[]) => rows
    .flatMap((m) => (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text' && b.text?.startsWith('[wake onboarding]')).map((b) => b.text!));
  /** The notices the agent was shown (#291): those in its window. */
  const notices = (agent = 'agent') => noticesIn(f.framework.getAgent(agent)!.getContextManager().getPresentedMessages() as unknown as Row[]);
  /** The notices stored, whoever they are for: none means none was written. */
  const stored = () => noticesIn(f.framework.getAgent('agent')!.getContextManager().getAllMessages() as unknown as Row[]);
  /** The window's texts, in order. */
  const window = (agent = 'agent') => (f.framework.getAgent(agent)!.getContextManager().getPresentedMessages() as unknown as Row[])
    .map((m) => (m.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? '').join(''));
  const gateJson = () => JSON.parse(readFileSync(join(f.dir, 'store', 'config', 'gate.json'), 'utf8')) as { policies: GatePolicy[] };
  const decisionsPath = join(f.dir, 'store', 'config', 'wake-decisions.json');
  const tool = async (name: string, input: Record<string, unknown>) => (await f.framework.puppetToolCall('agent', name, input)).result;
  const decisions = () => (f.framework as unknown as { wakeDecisions: WakeDecisions }).wakeDecisions;
  return { f, traces, push, woke, notices, stored, window, gateJson, decisionsPath, tool, decisions };
}

describe('wake onboarding: the host', () => {
  it('a Go turn skipped by a catch-all wakes the agent once with the server\'s suggestions; accepting writes them ahead of it', { timeout: 60_000 }, async () => {
    const h = await games();
    try {
      await h.push('verso joined as White. Your move.', ['surface:turn', 'go:start']);
      await eventually(() => h.notices().length === 1, 'the onboarding notice');
      const notice = h.notices()[0]!;
      assert.match(notice, /Events from the MCPL server "editor" reach your context without waking you/);
      assert.match(notice, /by your rule "discord-ambient", which names neither "editor" nor any of its tags/);
      assert.match(notice, /1\. Events tagged any of "surface:turn", "surface:invite": wake you\. Why: "An opponent is waiting on you\."/);
      assert.match(notice, /2\. Events tagged any of "games:chat": wake you once, 60 s after a burst goes quiet/);
      assert.match(notice, /wake_accept_suggestions \{ server: "editor" \}/);
      assert.match(notice, /"editor"'s own words, from a server that may not be trustworthy: accept what serves you, with reasonable caution, and when in doubt, ask a person or another agent/);
      assert.ok(h.woke(), 'it woke the agent to decide');
      const shown = h.window();
      const at = shown.findIndex((t) => t.includes('verso joined as White'));
      assert.ok(at >= 0 && shown[at + 1]!.startsWith('[wake onboarding]'), 'the notice follows the event it is about in the window');
      assert.ok(JSON.stringify(h.f.membrane.calls[0]).includes('[wake onboarding] Events from the MCPL server'), 'the turn it woke carried it');
      const offered = h.traces.find((t) => t.type === 'gate:onboarding-offered');
      assert.deepEqual({ ...offered, timestamp: undefined }, { type: 'gate:onboarding-offered', serverId: 'editor', digest: offered!.digest, policy: 'discord-ambient', rules: 2, wake: true, timestamp: undefined });
      assert.equal(JSON.parse(readFileSync(h.decisionsPath, 'utf8')).servers.editor.state, 'offered');

      await h.push('White played E5. Your move.', ['surface:turn', 'go:move']);
      assert.equal(h.stored().length, 1, 'asked once');

      const tags = await h.tool('event_tags', {});
      const onboarding = (tags.data as { onboarding: { offers: Record<string, { rules: unknown[] }>; decisions: Record<string, { state: string }> } }).onboarding;
      assert.equal(onboarding.offers.editor!.rules.length, 2);
      assert.equal(onboarding.decisions.editor!.state, 'offered');

      const accepted = await h.tool('wake_accept_suggestions', { server: 'editor', rules: [1] });
      assert.equal(accepted.success, true, accepted.error);
      assert.equal((accepted.data as { placedBefore: string }).placedBefore, 'discord-ambient');
      assert.deepEqual(h.gateJson().policies.map((p) => p.name), ['suggested:editor:1', 'discord-ambient']);
      assert.deepEqual(h.gateJson().policies[0]!.match, { source: 'editor', tagsAny: ['surface:turn', 'surface:invite'] });
      assert.equal(JSON.parse(readFileSync(h.decisionsPath, 'utf8')).servers.editor.state, 'accepted');

      h.traces.length = 0;
      await h.push('White played D4. Your move.', ['surface:turn', 'go:move']);
      await eventually(() => h.traces.some((t) => t.type === 'admission:decided'), 'the next turn\'s admission');
      assert.equal(h.traces.find((t) => t.type === 'admission:decided')!.wake, true, 'the next turn wakes the agent');

      const all = await h.tool('wake_accept_suggestions', { server: 'editor' });
      assert.equal(all.success, true, all.error);
      assert.deepEqual(h.gateJson().policies.map((p) => p.name), ['suggested:editor:1', 'suggested:editor:2', 'discord-ambient'], 'accepting again replaces the set');

      const declined = await h.tool('wake_decline', { server: 'editor' });
      assert.equal(declined.success, true, declined.error);
      assert.deepEqual((declined.data as { removed: string[] }).removed, ['suggested:editor:1', 'suggested:editor:2']);
      assert.deepEqual(h.gateJson().policies.map((p) => p.name), ['discord-ambient']);
      assert.equal(JSON.parse(readFileSync(h.decisionsPath, 'utf8')).servers.editor.state, 'declined');

      const bad = await h.tool('wake_accept_suggestions', { server: 'editor', rules: [7] });
      assert.equal(bad.isError, true);
      assert.match(bad.error!, /numbered 1 to 2/);
      const nobody = await h.tool('wake_decline', { server: 'nobody' });
      assert.match(nobody.error!, /no MCPL server is called "nobody"\. Servers: "editor"/);
    } finally { await h.f.close(); }
  });

  it('an undecided event that waits on no one leaves its offer for the next turn, without a wake', { timeout: 60_000 }, async () => {
    const h = await games();
    try {
      await h.push('Someone in the audience waved.', ['games:chat']);
      await eventually(() => h.notices().length === 1, 'the onboarding notice');
      assert.equal(h.woke(), false, 'no wake');
      assert.equal(h.traces.find((t) => t.type === 'gate:onboarding-offered')!.wake, false);
    } finally { await h.f.close(); }
  });

  it('a rule the agent wrote for the server is a decision: no offer', { timeout: 60_000 }, async () => {
    const h = await games({ policies: [{ name: 'editor-quiet', match: { source: 'editor' }, behavior: 'defer' }, CATCH_ALL] });
    try {
      await h.push('Your move.', ['surface:turn']);
      assert.equal(h.stored().length, 0);
      assert.equal(existsSync(h.decisionsPath), false);
    } finally { await h.f.close(); }
  });

  it('a server that declares nothing gets the host\'s attention rule; the default is undecided too', { timeout: 60_000 }, async () => {
    const h = await games({ policies: [], ontology: null });
    try {
      await h.push('Your move.', ['surface:turn']);
      await eventually(() => h.notices().length === 1, 'the onboarding notice');
      assert.match(h.notices()[0]!, /was let by \(skip\) by the gate's default/);
      assert.match(h.notices()[0]!, /declares no suggestions the host can use\. The host offers one rule:/);
      const accepted = await h.tool('wake_accept_suggestions', { server: 'editor' });
      assert.equal(accepted.success, true, accepted.error);
      assert.deepEqual(h.gateJson().policies.map((p) => [p.name, p.match]), [
        ['suggested:editor:1', { source: 'editor', tagsAny: [...ATTENTION_TAGS] }],
      ]);
      const status = await h.tool('gate_status', {});
      assert.equal((status.data as { catchAll?: unknown }).catchAll, undefined);
    } finally { await h.f.close(); }
  });

  it('gate_status names the catch-all; onboarding: false turns it all off', { timeout: 60_000 }, async () => {
    const h = await games({ onboarding: false });
    try {
      const status = await h.tool('gate_status', {});
      assert.equal((status.data as { catchAll: { rule: string } }).catchAll.rule, 'discord-ambient');
      await h.push('Your move.', ['surface:turn']);
      assert.equal(h.stored().length, 0);
      await assert.rejects(h.tool('wake_accept_suggestions', { server: 'editor' }), /not on agent's surface/, 'no such tool');
    } finally { await h.f.close(); }
  });

  it('channel messages: an ambient one skipped by the catch-all brings the offer without a wake; an addressed one would wake', { timeout: 60_000 }, async () => {
    const h = await games();
    try {
      await registerOpen(h.f, 'chat');
      await incoming(h.f, 'chat', 'm1', 'hello room', AMBIENT);
      await h.f.framework.runUntilIdle();
      await eventually(() => h.notices().length === 1, 'the onboarding notice');
      const offered = h.traces.find((t) => t.type === 'gate:onboarding-offered')!;
      assert.equal(offered.policy, 'discord-ambient');
      assert.equal(offered.wake, false);
      assert.equal(h.woke(), false);
    } finally { await h.f.close(); }
    const g = await games();
    try {
      await registerOpen(g.f, 'chat');
      await incoming(g.f, 'chat', 'm2', 'verso, your move', MENTION);
      await g.f.framework.runUntilIdle();
      await eventually(() => g.notices().length === 1, 'the onboarding notice');
      assert.equal(g.traces.find((t) => t.type === 'gate:onboarding-offered')!.wake, true);
      assert.ok(g.woke());
      assert.ok(g.f.published.some((p) => p.channelId === 'chat'), 'the turn it woke speaks in the channel that addressed the agent');
    } finally { await g.f.close(); }
  });

  it('on a residents\' host, a targeted event\'s offer is for its recipients: shown and woken there alone (#291)', { timeout: 60_000 }, async () => {
    const h = await games({ agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }, { name: 'oren', model: 'test', systemPrompt: 'test' }] });
    try {
      // As a module's or a router's targeted push is queued: one the wire doesn't carry.
      h.f.framework.pushEvent({
        type: 'mcpl:push-event', serverId: 'editor', featureSet: 'games', eventId: 'for-oren', timestamp: TS, inferenceId: 'inf-for-oren',
        content: [{ type: 'text', text: 'oren, your move.' }], tags: ['surface:turn'], targetAgents: ['oren'],
      } as never);
      await h.f.framework.runUntilIdle();
      await eventually(() => h.notices('oren').length === 1, 'the notice in oren\'s window');
      assert.equal(h.notices('agent').length, 0, 'not shown to a co-resident the event wasn\'t for');
      const row = (h.f.framework.getAgent('agent')!.getContextManager().getAllMessages() as unknown as Array<{ content: Array<{ text?: string }>; metadata?: Record<string, unknown> }>)
        .find((m) => m.content.some((b) => b.text?.startsWith('[wake onboarding]')))!;
      assert.deepEqual(row.metadata?.audience, ['oren'], 'stamped for the event\'s recipients, as the event is');
      const woken = h.traces.filter((t) => t.type === 'inference:started').map((t) => t.agentName);
      assert.deepEqual([...new Set(woken)], ['oren'], 'only the recipient is woken to decide');
    } finally { await h.f.close(); }
  });

  it('a held (tuned-out) channel message brings no offer', { timeout: 60_000 }, async () => {
    const h = await games({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(h.f, 'noisy');
      enter(h.f, 'noisy');
      await incoming(h.f, 'noisy', 'n1', 'noise', MENTION);
      await h.f.framework.runUntilIdle();
      assert.equal(h.stored().length, 0);
      assert.ok(!h.traces.some((t) => t.type === 'gate:onboarding-offered'));
    } finally { await h.f.close(); }
  });

  it('offers only what the host enabled; a bare * tag rule is a catch-all; an invite alone doesn\'t wake; short spans read in ms', { timeout: 60_000 }, async () => {
    const h = await games({
      policies: [{ name: 'all-tags', match: { tagsAny: ['*'] }, behavior: 'skip' }],
      ontology: { suggestedTreatment: [{ tagsAny: ['games:chat'], behavior: { debounce: 250 } }, { tagsAny: ['games:spam'], behavior: { sample: { every: 3 } } }] },
      extraFeatureSets: { extra: { description: 'not enabled', uses: ['pushEvents'], tagOntology: { suggestedTreatment: [{ tagsAny: ['extra:ping'], behavior: 'immediate' }] } } },
    });
    try {
      await h.push('Rematch?', ['surface:invite']);
      await eventually(() => h.notices().length === 1, 'the onboarding notice');
      const notice = h.notices()[0]!;
      assert.match(notice, /by your rule "all-tags"/);
      assert.match(notice, /wake you once, 250 ms after a burst goes quiet/);
      assert.doesNotMatch(notice, /extra:ping/, 'a feature set the host never enabled is not offered');
      assert.match(notice, /2\. Events tagged any of "games:spam": wake you for one in every 3\./);
      assert.equal(h.woke(), false);
      const tags = await h.tool('event_tags', {});
      const offers = (tags.data as { onboarding: { offers: Record<string, { rules: Array<{ n: number; match: unknown }> }> } }).onboarding.offers;
      assert.deepEqual(offers.editor!.rules.map((r) => [r.n, r.match]), [[1, { tagsAny: ['games:chat'] }], [2, { tagsAny: ['games:spam'] }]], 'event_tags numbers as the notice does');
    } finally { await h.f.close(); }
  });

  it('accepting refuses numbers the agent wasn\'t shown, and puts the earlier set back when a write fails', { timeout: 60_000 }, async () => {
    const h = await games();
    try {
      await h.push('Your move.', ['surface:turn']);
      await eventually(() => h.notices().length === 1, 'the onboarding notice');
      const shown = h.decisions().get('editor')!.digest;
      // As if the server's suggestions had changed since the notice.
      h.decisions().set('editor', { digest: 'an-older-ontology', state: 'offered' });
      const drifted = await h.tool('wake_accept_suggestions', { server: 'editor', rules: [1] });
      assert.equal(drifted.isError, true);
      assert.match(drifted.error!, /suggestions changed since you were told about them, so nothing was written\. They are now:\n  1\. Events tagged any of "surface:turn"/);
      assert.deepEqual(h.gateJson().policies.map((p) => p.name), ['discord-ambient']);
      assert.equal(h.decisions().get('editor')!.shown, shown, 'shown again: what it declares now');
      assert.equal(h.decisions().get('editor')!.digest, 'an-older-ontology', 'the decision on record stays as it was');
      assert.equal((await h.tool('wake_accept_suggestions', { server: 'editor', rules: [1] })).success, true);

      const original = h.f.framework.addGatePolicy.bind(h.f.framework);
      let calls = 0;
      (h.f.framework as unknown as { addGatePolicy: typeof original }).addGatePolicy = (policy, options) => {
        if (++calls === 2) throw new Error('disk full');
        return original(policy, options);
      };
      const failed = await h.tool('wake_accept_suggestions', { server: 'editor' });
      assert.equal(failed.isError, true);
      assert.match(failed.error!, /nothing was accepted: disk full/);
      assert.deepEqual(h.gateJson().policies.map((p) => p.name), ['suggested:editor:1', 'discord-ambient'], 'the earlier set is back where it was');
      assert.deepEqual(h.decisions().get('editor')!.rules, ['suggested:editor:1']);
      (h.f.framework as unknown as { addGatePolicy: typeof original }).addGatePolicy = original;

      // A drift refusal leaves an acceptance on record, and its time.
      const current = h.decisions().get('editor')!.digest;
      const then = Date.now() - 60_000;
      h.decisions().set('editor', { digest: 'an-older-ontology', state: 'accepted', rules: ['suggested:editor:1'] }, then);
      const refused = await h.tool('wake_accept_suggestions', { server: 'editor' });
      assert.match(refused.error!, /changed since you were told/);
      assert.deepEqual({ ...h.decisions().get('editor') }, { digest: 'an-older-ontology', state: 'accepted', rules: ['suggested:editor:1'], shown: current, at: new Date(then).toISOString() });
      assert.equal((await h.tool('wake_accept_suggestions', { server: 'editor' })).success, true, 'now shown: accepted');
      assert.deepEqual(h.gateJson().policies.map((p) => p.name), ['suggested:editor:1', 'suggested:editor:2', 'discord-ambient']);

      // Decline is one change too.
      const remove = h.f.framework.removeGatePolicy.bind(h.f.framework);
      let removals = 0;
      (h.f.framework as unknown as { removeGatePolicy: typeof remove }).removeGatePolicy = (name) => {
        if (++removals === 2) throw new Error('disk full');
        return remove(name);
      };
      const declineFailed = await h.tool('wake_decline', { server: 'editor' });
      assert.match(declineFailed.error!, /nothing was declined: disk full/);
      assert.deepEqual(h.gateJson().policies.map((p) => p.name), ['suggested:editor:1', 'suggested:editor:2', 'discord-ambient'], 'what was removed is back');
      assert.equal(h.decisions().get('editor')!.state, 'accepted');
    } finally { await h.f.close(); }
  });

  it('a disconnected server: decline stands for what it was asked about, accept waits for it', { timeout: 60_000 }, async () => {
    const h = await games();
    try {
      await h.push('Your move.', ['surface:turn']);
      await eventually(() => h.notices().length === 1, 'the onboarding notice');
      const digest = h.decisions().get('editor')!.digest;
      h.f.online(false);
      h.f.disconnect();
      const fsm = (h.f.framework as unknown as { featureSetManager?: { getDeclaredFeatureSets(id: string): unknown } }).featureSetManager;
      await eventually(() => fsm?.getDeclaredFeatureSets('editor') == null, 'the declarations going');
      const accept = await h.tool('wake_accept_suggestions', { server: 'editor' });
      assert.match(accept.error!, /"editor" isn't connected/);
      h.traces.length = 0;
      const decline = await h.tool('wake_decline', { server: 'editor' });
      assert.equal(decline.success, true, decline.error);
      assert.equal(h.decisions().get('editor')!.digest, digest);
      assert.equal(h.traces.find((t) => t.type === 'gate:onboarding-decided')!.digest, digest, 'the trace names what was stored');
    } finally { await h.f.close(); }
  });

  // The notice's wake reads the notice's row (readsRowFor), as the event's
  // own wake reads the event's: a turn that heard the notice and was answered
  // has done what the wake was for, so the wake starts no turn of its own.
  it('a notice stored mid-turn, heard at the turn\'s tool boundary and answered, drops its wake: it reads the notice\'s row', { timeout: 60_000 }, async () => {
    const hold = new HoldRound();
    const h = await games({
      policies: [{ name: 'go-start', match: { tagsAny: ['go:start'] }, behavior: 'always' }, CATCH_ALL],
      framework: { modules: [hold] } as Partial<FrameworkConfig>,
    });
    // The scheduler's drop of a marked wake, as it logs it.
    const drops: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.startsWith('[wake] agent: dropped')) drops.push(line);
      else consoleError(...args);
    };
    try {
      // One turn, on membrane's native path, which carries what a tool
      // boundary injects into its next round: it waits on hold--wait, then says ok.
      const streams: MockYieldingStream[] = [];
      (h.f.membrane as unknown as { streamYielding: (req: unknown) => MockYieldingStream }).streamYielding = (req) => {
        h.f.membrane.calls.push(req as never);
        const stream = new MockYieldingStream(streams.length === 0
          ? [createMockResponse([{ type: 'tool_use', id: 'c1', name: 'hold--wait', input: {} }], 'tool_use'), ok()]
          : [ok()], true);
        streams.push(stream);
        return stream;
      };
      const pending = () => (h.f.framework as unknown as { pendingRequests: Array<{ reason: string; readsRow?: string }> }).pendingRequests;
      let queued: Array<string | undefined> = [];
      // While the turn waits on its tool, an event the catch-all lets by
      // brings the offer: its notice is stored out of the live turn's window,
      // and its wake waits behind the busy agent.
      hold.during = async () => {
        await h.f.send('push/event', { featureSet: 'games', eventId: 'mid', timestamp: TS, tags: ['surface:turn'], payload: { content: [{ type: 'text', text: 'White played E5. Your move.' }] } });
        await eventually(() => h.traces.some((t) => t.type === 'gate:onboarding-offered'), 'the offer, made mid-turn');
        queued = pending().filter((r) => r.reason === 'wake-onboarding').map((r) => r.readsRow);
      };
      await h.f.send('push/event', { featureSet: 'games', eventId: 'start', timestamp: TS, tags: ['go:start'], payload: { content: [{ type: 'text', text: 'verso joined as White.' }] } });
      await h.f.framework.runUntilIdle();

      const row = (h.f.framework.getAgent('agent')!.getContextManager().getAllMessages() as unknown as Array<{ id: string; content: Array<{ text?: string }> }>)
        .find((m) => m.content.some((b) => b.text?.startsWith('[wake onboarding]')));
      assert.ok(row, 'the notice was stored');
      assert.deepEqual(queued, [row.id], 'its wake reads the notice\'s stored row');
      assert.equal(h.traces.find((t) => t.type === 'gate:onboarding-offered')!.wake, true, 'the offer woke the agent to decide');
      assert.ok(JSON.stringify(streams[0]!.receivedToolResultOptions).includes('[wake onboarding] Events from the MCPL server'), 'the turn heard the notice at its tool boundary');
      assert.equal(h.notices().length, 1, 'the notice is in the window');
      assert.equal(h.traces.filter((t) => t.type === 'inference:started').length, 1, 'its wake started no turn: the answered turn carried the notice');
      assert.equal(h.f.membrane.calls.length, 1);
      assert.ok(drops.length === 1 && drops[0]!.includes('dropped 1 wake(s)') && drops[0]!.endsWith('no turn starts'), `its wake was dropped: ${JSON.stringify(drops)}`);
      assert.equal(pending().length, 0);
    } finally {
      console.error = consoleError;
      await h.f.close();
    }
  });

  it('a changed ontology is asked about again, once a day has passed since the last question', { timeout: 60_000 }, async () => {
    const h = await games();
    try {
      const hour = 60 * 60 * 1000;
      h.decisions().set('editor', { digest: 'an-older-ontology', state: 'declined' }, Date.now() - hour);
      await h.push('Your move.', ['surface:turn']);
      assert.equal(h.stored().length, 0, 'within the day: not yet');
      h.decisions().set('editor', { digest: 'an-older-ontology', state: 'declined' }, Date.now() - 25 * hour);
      await h.push('Your move.', ['surface:turn']);
      await eventually(() => h.notices().length === 1, 'the onboarding notice');
    } finally { await h.f.close(); }
  });
});

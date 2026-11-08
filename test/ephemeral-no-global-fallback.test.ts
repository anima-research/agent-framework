/**
 * An ephemeral run (a subagent) takes no process-global fallback (#551). The
 * fallback is the channel of the most recent delivered inbound message: a
 * resident's turn with no channel of its own speaks there. A subagent's plain
 * prose is its caller's result, so that channel is never where it lands,
 * never its channel context's default outgoing channel or `incoming` message,
 * never `channel_publish`'s default, and never where its refusal is marked or
 * logged. With no channel of its own, its prose is not delivered, and nothing
 * reports a failure. A channel the run opens itself is still its own.
 *
 * Harness: the RFC-006 loopback MCPL server and a mocked model; the event
 * loop is driven explicitly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContextManager, PassthroughStrategy } from '@animalabs/context-manager';
import { fixture as baseFixture, eventually, settles, TS } from './helpers/coalescing-fixture.js';

// These tests are about the global fallback itself — the latest delivered
// inbound channel — so they run under the rule that has one. Dendrite's
// default (`speech.locus: 'delivery'`) gives a resident with no delivery no
// locus at all, which is a different case (admission-e2e covers it).
const fixture: typeof baseFixture = (options = {}) =>
  baseFixture({ ...options, framework: { speech: { locus: 'latest-inbound' }, ...options.framework } });
import { createMockResponse } from './helpers/mock-membrane.js';
import { gateToolCalls } from './helpers/gate-tool-calls.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Ref = { serverId: string; channelId: string };
type Registry = {
  getDefaultPublishChannel(): Ref | null;
  getDesiredState(serverId: string, channelId: string): string | undefined;
  resolveLocus(conversationId: string): Ref | null;
  buildChannelContext(agentName: string | undefined, serverId: string): { incoming?: { channelId: string }; defaultOutgoing?: { channelId: string } } | undefined;
  routeSpeech(conversationId: string, text: string, locus: Ref | null): Promise<unknown>;
  deliverSpeech(conversationId: string, text: string, locus: Ref | null, opts?: unknown): Promise<unknown>;
  handleChannelToolCall(toolName: string, input: unknown, origin?: unknown): Promise<{ success: boolean; error?: string }>;
};
const registry = (f: Fixture) => (f.framework as unknown as { channelRegistry: Registry }).channelRegistry;

const BUSY = 'discord:g1:busy';
const SIDE = 'discord:g1:side';
/** A channel on the fixture's server. */
const editor = (channelId: string): Ref => ({ serverId: 'editor', channelId });
const text = (t: string) => createMockResponse([{ type: 'text', text: t }]);
const publishedText = (f: Fixture) => JSON.stringify(f.published);

/** Open `busy`, and let a resident's reply there make it the latest inbound channel: the global fallback. */
async function busyFallback(f: Fixture): Promise<void> {
  await f.send('channels/register', {
    channels: [
      { id: BUSY, type: 'discord', label: 'busy', initiallyOpen: true, metadata: { channelType: 'guild_text' } },
      { id: SIDE, type: 'discord', label: 'side', metadata: { channelType: 'guild_text' } },
    ],
  });
  await eventually(() => registry(f).getDesiredState('editor', BUSY) === 'open', 'busy is open');
  await f.send('channels/incoming', {
    messages: [{
      channelId: BUSY, messageId: 'b1', timestamp: TS, author: { id: 'U1', name: 'antra' },
      tags: ['chat:mention', 'chat:addressed', 'chat:from-human'], content: [{ type: 'text', text: 'hello agent' }],
    }],
  });
  await f.framework.runUntilIdle(); // the resident answers with the fixture's scripted 'ok'
  assert.deepEqual(registry(f).getDefaultPublishChannel(), editor(BUSY), 'control: busy is the global fallback');
}

/**
 * Run one subagent to completion and return its result. A run's final speech
 * is routed after the run settles, and may be in flight after its release,
 * so with `speech: true` this waits for the run's speech to reach
 * deliverSpeech and for each delivery to settle: a post the run made is then
 * at the server, and one it didn't make can't still arrive.
 */
async function runSubagent(
  f: Fixture, name: string, proseRouting: 'locus' | 'hybrid', speech: boolean, ...responses: ReturnType<typeof text>[]
) {
  const reg = registry(f);
  const deliver = reg.deliverSpeech.bind(reg);
  const deliveries: Promise<unknown>[] = [];
  reg.deliverSpeech = (...args) => {
    const done = deliver(...args);
    if (args[0] === name) deliveries.push(done);
    return done;
  };
  try {
    const created = await f.framework.createEphemeralAgent({
      name, model: 'test', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting,
    });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'Find it and report back.' }]);
    for (const r of responses) f.membrane.pushResponse(r);
    const run = f.framework.runEphemeralToCompletion(created.agent, created.contextManager);
    await f.framework.runUntilIdle();
    const result = await run;
    await f.framework.runUntilIdle();
    if (speech) {
      await eventually(() => deliveries.length > 0, `${name}'s speech reached deliverSpeech`);
      await settles(Promise.all(deliveries), `${name}'s speech deliveries`);
    }
    return result;
  } finally {
    reg.deliverSpeech = deliver;
  }
}

/** What the run left in its own namespace. */
async function archived(f: Fixture, name: string): Promise<string> {
  const archive = await ContextManager.open({
    store: f.framework.getStore(), namespace: `subagent/${name}`, isolate: true, strategy: new PassthroughStrategy(),
  });
  return JSON.stringify(archive.getAllMessages());
}

function speechTraces(f: Fixture) {
  const seen: Array<{ type: string; conversationId?: string; channelId?: string }> = [];
  const off = f.framework.onTrace((t) => {
    const type = String((t as { type: string }).type);
    if (type === 'mcpl:speech-routed' || type === 'mcpl:speech-route-failed') seen.push(t as never);
  });
  return { seen, off };
}

describe('an ephemeral run takes no global fallback (#551)', () => {
  for (const mode of ['locus', 'hybrid'] as const) {
    it(`a ${mode}-mode subagent's final prose is returned to its caller, not posted to the latest inbound channel`, async () => {
      const f = await fixture();
      const t = speechTraces(f);
      try {
        await busyFallback(f);
        const result = await runSubagent(f, `sub-${mode}`, mode, true, text('subagent private findings'));

        assert.match(result.speech, /subagent private findings/, 'the caller gets the prose');
        assert.ok(!publishedText(f).includes('subagent private findings'), `not published: ${publishedText(f)}`);
        const own = t.seen.filter((x) => x.conversationId === `sub-${mode}`);
        assert.deepEqual(own, [], 'neither routed nor counted as a failed route');
        // Control: a name the framework didn't reserve for a run, with no
        // turn of its own (a resident's heartbeat, say), still resolves the
        // fallback.
        assert.deepEqual(registry(f).resolveLocus('resident-with-no-turn'), editor(BUSY), 'control: the fallback is kept for others');
      } finally { t.off(); await f.close(); }
    });
  }

  it('channel_publish with no channelId is refused for a subagent, and publishes to a channel it names; a resident keeps the default', async () => {
    const f = await fixture();
    try {
      await busyFallback(f);
      const tool = (id: string, input: Record<string, unknown>) =>
        createMockResponse([{ type: 'tool_use', id, name: 'channel_publish', input }], 'tool_use');
      await runSubagent(f, 'sub-publish', 'locus', false,
        tool('p1', { content: 'unnamed post' }),
        tool('p2', { channelId: BUSY, content: 'named post' }),
        text('done'));

      // Both tool calls finished inside the run's turn, before it settled.
      const posted = publishedText(f);
      assert.ok(!posted.includes('unnamed post'), `the unnamed post went nowhere: ${posted}`);
      assert.ok(posted.includes('named post'), 'a channel the subagent names is published to');
      const archive = await archived(f, 'sub-publish');
      assert.ok(archive.includes('name the channel with channelId. A subagent has no default channel'), 'the refusal says to name the channel');

      // Control: a resident's channel_publish with no channelId still goes to the latest inbound channel.
      const resident = await registry(f).handleChannelToolCall('channel_publish', { content: 'resident unnamed post' }, { kind: 'agent', agentName: 'agent' });
      assert.equal(resident.success, true, resident.error);
      const post = f.published.find((p) => JSON.stringify(p).includes('resident unnamed post')) as { channelId?: string } | undefined;
      assert.equal(post?.channelId, BUSY, 'control: the resident\'s unnamed post went to busy');
    } finally { await f.close(); }
  });

  it('a subagent\'s channel context names no default outgoing channel and no incoming message, a subagent named \'\' included; a resident\'s does', async () => {
    const f = await fixture();
    try {
      await busyFallback(f);
      for (const name of ['sub-context', '']) {
        await f.framework.createEphemeralAgent({ name, model: 'test', systemPrompt: 'Do the task.', proseRouting: 'locus' });
        const sub = registry(f).buildChannelContext(name, 'editor');
        assert.ok(sub, `${JSON.stringify(name)} has a channel context: busy is open`);
        assert.equal(sub.defaultOutgoing, undefined, JSON.stringify(name));
        assert.equal(sub.incoming, undefined, JSON.stringify(name));
      }
      const resident = registry(f).buildChannelContext('agent', 'editor');
      assert.equal(resident?.defaultOutgoing?.channelId, BUSY, 'control');
      assert.equal(resident?.incoming?.channelId, BUSY, 'control');
    } finally { await f.close(); }
  });

  it('a subagent named \'\' that opened a channel is told that channel, where its speech goes', async () => {
    const f = await fixture();
    try {
      await busyFallback(f);
      await f.framework.createEphemeralAgent({ name: '', model: 'test', systemPrompt: 'Do the task.', proseRouting: 'locus' });
      // The run's turn opened side: its routing state names it, as
      // channel_open's result leaves it.
      (f.framework as unknown as { turnRouting: Map<string, { locus?: Ref }> }).turnRouting.set('', { locus: editor(SIDE) });

      assert.deepEqual(registry(f).resolveLocus(''), editor(SIDE), 'control: its speech goes to side');
      assert.equal(registry(f).buildChannelContext('', 'editor')?.defaultOutgoing?.channelId, SIDE, 'and its channel context says so');
    } finally { await f.close(); }
  });

  it('a subagent\'s refusal is marked on no one\'s message; a resident\'s still is', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const f = await fixture({ toolsCall: (params) => { calls.push(params); return { content: [] }; } });
    try {
      await busyFallback(f);
      await f.framework.createEphemeralAgent({ name: 'sub-refused', model: 'test', systemPrompt: 'Do the task.', proseRouting: 'locus' });
      const react = (name: string) =>
        (f.framework as unknown as { reactToRefusal(name: string, category: string): Promise<void> }).reactToRefusal(name, 'other');

      await react('sub-refused');
      assert.equal(calls.length, 0, 'no reaction for the subagent\'s refusal');
      await react('agent');
      await eventually(() => calls.length === 1, 'control: the resident\'s refusal is marked');
      assert.equal(calls[0]!.name, 'add_reaction');
    } finally { await f.close(); }
  });

  it('a subagent\'s refusal is logged with no locus; a resident\'s with the latest inbound channel', async (t) => {
    const f = await fixture();
    try {
      await busyFallback(f);
      await f.framework.createEphemeralAgent({ name: 'sub-logged', model: 'test', systemPrompt: 'Do the task.', proseRouting: 'locus' });
      const fw = f.framework as unknown as {
        logFailure(record: Record<string, unknown>): void;
        noteRefusal(name: string, category: string): number;
      };
      const records: Array<Record<string, unknown>> = [];
      t.mock.method(fw, 'logFailure', (record: Record<string, unknown>) => { records.push(record); });

      fw.noteRefusal('sub-logged', 'other');
      fw.noteRefusal('agent', 'other');
      assert.deepEqual(records.map((r) => [r.agent, r.kind, r.locus]), [['sub-logged', 'refusal', null], ['agent', 'refusal', BUSY]]);
    } finally { await f.close(); }
  });

  it('after the run is released, its name still takes no fallback, and a dispatch with no locus stays quiet', async () => {
    const f = await fixture();
    const t = speechTraces(f);
    try {
      await busyFallback(f);
      await runSubagent(f, 'sub-late', 'locus', true, text('first findings'));
      assert.equal(f.framework.getAgent('sub-late'), null, 'released');

      assert.equal(registry(f).resolveLocus('sub-late'), null);
      assert.equal(await registry(f).routeSpeech('sub-late', 'late words', null), null);
      assert.deepEqual(t.seen.filter((x) => x.conversationId === 'sub-late'), []);
    } finally { t.off(); await f.close(); }
  });

  it('a conversation fork, whose name is reserved like a run\'s, keeps the fallback', async () => {
    const f = await fixture({ framework: { conversations: { templateAgent: 'agent', bind: { channel: 'always' } } } as never });
    try {
      await f.send('channels/register', {
        channels: [{ id: BUSY, type: 'discord', label: 'busy', initiallyOpen: true, metadata: { channelType: 'guild_text' } }],
      });
      await eventually(() => registry(f).getDesiredState('editor', BUSY) === 'open', 'busy is open');
      await f.send('channels/incoming', {
        messages: [{
          channelId: BUSY, messageId: 'b1', timestamp: TS, author: { id: 'U1', name: 'antra' },
          tags: ['chat:ambient', 'chat:from-human'], content: [{ type: 'text', text: 'ambient words' }],
        }],
      });
      await f.framework.runUntilIdle();
      const fork = (f.framework as unknown as { getConversationRouter(): { getBinding(channel: Ref): { agentName: string } | undefined } })
        .getConversationRouter().getBinding(editor(BUSY))?.agentName;
      assert.ok(fork, 'a conversation fork was spawned for busy');

      assert.equal(registry(f).buildChannelContext(fork, 'editor')?.incoming?.channelId, BUSY, 'its channel context still names the latest inbound message');
    } finally { await f.close(); }
  });

  it('a subagent\'s sleep is refused, and the gate stays awake', async () => {
    const f = await fixture({ framework: { gate: { config: { default: 'always' } } } as never });
    const calls = gateToolCalls(f.framework);
    try {
      await busyFallback(f);
      await runSubagent(f, 'sub-sleep', 'locus', true,
        createMockResponse([{ type: 'tool_use', id: 's1', name: 'sleep', input: { seconds: 60 } }], 'tool_use'),
        text('done'));

      assert.equal(calls.refused.length, 1, calls.refused.join('\n'));
      assert.ok(calls.refused[0]!.startsWith('sleep: ') && /nothing was set/i.test(calls.refused[0]!) && calls.refused[0]!.includes('quiets the whole agent'), calls.refused[0]);
      assert.equal((f.framework as unknown as { eventGate: { getSleepState(): unknown } }).eventGate.getSleepState(), null, 'the gate stays awake');
    } finally { await f.close(); }
  });

  it('a channel the subagent opens itself is still where its prose lands', async () => {
    const f = await fixture();
    try {
      await busyFallback(f);
      await runSubagent(f, 'sub-side', 'locus', true,
        createMockResponse([{ type: 'tool_use', id: 'o1', name: 'channel_open', input: { channelId: SIDE } }], 'tool_use'),
        text('said in side'));

      const sideposts = f.published.filter((p) => JSON.stringify(p).includes('said in side'));
      assert.equal(sideposts.length, 1, `published once: ${publishedText(f)}`);
      assert.equal((sideposts[0] as { channelId?: string }).channelId, SIDE);
    } finally { await f.close(); }
  });
});

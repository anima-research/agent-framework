/**
 * FocusCoordinator — unit tests against stub registry/hooks.
 *
 * Covers: hold predicate (focus channel passes, everything else held),
 * autoreply once per (channel, author) per epoch, end dump with per-channel
 * cap + backscroll hint naming only tools the resident has, re-target
 * (release + no double delivery), duration clamps, expiry at resume.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredMessage } from '@animalabs/context-manager';
import { FocusCoordinator, DEFAULT_AUTOREPLY, type FocusFrameworkHooks } from '../src/focus/coordinator.js';
import type { ChannelRegistry, FocusParams } from '../src/mcpl/channel-registry.js';

/** Every coordinator built here; armed expiry timers are cleared at the end so
 *  no test leaves a live timer keeping the runner alive. */
const built: FocusCoordinator[] = [];
after(() => { for (const c of built) c.stop(); });

function harness(opts?: { tools?: string[]; autoReply?: boolean; maxDurationSeconds?: number }) {
  let focus: FocusParams | null = null;
  const stored: StoredMessage[] = [];
  const delivered: Array<{ participant: string; text: string; metadata?: Record<string, unknown> }> = [];
  const published: Array<{ channelId: string; text: string }> = [];
  const wakes: string[] = [];
  const gateStates: Array<FocusParams | null> = [];
  let seq = 0;

  const registry = {
    getFocus: () => focus,
    setFocus: (p: FocusParams | null) => { focus = p; },
    listChannelsRaw: () => [
      { serverId: 'discord', descriptor: { id: 'discord:g:work', label: 'work' } },
      { serverId: 'discord', descriptor: { id: 'discord:g:chat', label: 'chat' } },
      { serverId: 'discord', descriptor: { id: 'discord:dm:antra', label: 'DM: antra' } },
    ],
  } as unknown as ChannelRegistry;

  const hooks: FocusFrameworkHooks = {
    addMessage: (participant, content, metadata) => {
      const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      delivered.push({ participant, text, metadata });
      return `d-${delivered.length}`;
    },
    requestInference: (agentName) => { wakes.push(agentName); },
    primaryName: () => 'scout',
    getStoredMessages: () => stored,
    currentSequence: () => seq,
    channelLabel: (_s, c) => registry.listChannelsRaw().find((e) => e.descriptor.id === c)?.descriptor.label,
    publish: async (channelId, text) => { published.push({ channelId, text }); return { success: true }; },
    timeZone: () => 'UTC',
    availableToolNames: () => opts?.tools ?? ['history--extract', 'channel_open'],
    isForkRouted: () => false,
    onFocusChanged: (s) => { gateStates.push(s); },
    emitTrace: () => {},
  };
  const coordinator = new FocusCoordinator(registry, {
    enabled: true,
    autoReply: opts?.autoReply,
    defaultBacklogCap: 3,
    ...(opts?.maxDurationSeconds ? { maxDurationSeconds: opts.maxDurationSeconds } : {}),
  }, hooks);
  built.push(coordinator);

  /** Simulate the framework's ingestion: consult, stamp, store. */
  const incoming = (channelId: string, text: string, o?: { addressed?: boolean; authorId?: string }) => {
    const stamp = coordinator.onIncoming('discord', channelId, `m${++seq}`,
      o?.addressed ? ['chat:mention', 'chat:addressed'] : [], { id: o?.authorId ?? 'U1', name: 'someone' });
    stored.push({
      id: `m${seq}`, sequence: seq, participant: 'user', timestamp: new Date(seq * 1000),
      content: [{ type: 'text', text }],
      metadata: {
        channelId, serverId: 'discord', author: { id: o?.authorId ?? 'U1', name: 'someone' },
        ...(o?.addressed ? { tags: ['chat:mention', 'chat:addressed'] } : {}),
        ...(stamp ? { focusHeld: stamp } : {}),
      } as StoredMessage['metadata'],
    });
    return stamp;
  };

  return { coordinator, incoming, delivered, published, wakes, gateStates, stored, getFocus: () => focus };
}

describe('focus: hold predicate', () => {
  it('not focused → nothing is held', () => {
    const h = harness();
    assert.equal(h.incoming('discord:g:chat', 'hi'), null);
  });

  it('focus channel passes; every other channel and DM is held and stamped with the epoch', () => {
    const h = harness();
    const r = h.coordinator.enter('discord:g:work', {}, 'agent-tool');
    assert.ok(r.ok);
    assert.equal(h.incoming('discord:g:work', 'on topic'), null);
    const held = h.incoming('discord:g:chat', 'off topic');
    assert.equal(held?.epochId, h.getFocus()!.epochId);
    const dm = h.incoming('discord:dm:antra', 'psst');
    assert.equal(dm?.epochId, h.getFocus()!.epochId);
    // Gate predicate installed once on enter.
    assert.equal(h.gateStates.length, 1);
    assert.equal(h.gateStates[0]?.channelId, 'discord:g:work');
  });

  it('unknown channel and fork routing are refused', () => {
    const h = harness();
    const r = h.coordinator.enter('discord:g:nope', {}, 'agent-tool');
    assert.equal(r.ok, false);
  });
});

describe('focus: autoreply', () => {
  it('replies once per (channel, author) per epoch to addressed messages only', async () => {
    const h = harness();
    h.coordinator.enter('discord:g:work', {}, 'agent-tool');
    h.incoming('discord:g:chat', 'ambient', { authorId: 'A' });
    const first = h.incoming('discord:g:chat', '@scout?', { addressed: true, authorId: 'A' });
    const second = h.incoming('discord:g:chat', '@scout??', { addressed: true, authorId: 'A' });
    const other = h.incoming('discord:g:chat', '@scout', { addressed: true, authorId: 'B' });
    const elsewhere = h.incoming('discord:dm:antra', 'dm', { addressed: true, authorId: 'A' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.published.map((p) => p.channelId), ['discord:g:chat', 'discord:g:chat', 'discord:dm:antra']);
    assert.equal(first?.autoReplied, true);
    assert.equal(second?.autoReplied, undefined);
    assert.equal(other?.autoReplied, true);
    assert.equal(elsewhere?.autoReplied, true);
    assert.match(h.published[0]!.text, /scout is in focus mode/);
    assert.match(h.published[0]!.text, /^\[Automatic reply\]/);
  });

  it('autoReply: false suppresses the reply but still holds', async () => {
    const h = harness({ autoReply: false });
    h.coordinator.enter('discord:g:work', {}, 'agent-tool');
    const held = h.incoming('discord:g:chat', '@scout', { addressed: true });
    await new Promise((r) => setImmediate(r));
    assert.ok(held);
    assert.equal(h.published.length, 0);
  });

  it('the default template carries no placeholder residue', async () => {
    const h = harness();
    h.coordinator.enter('discord:g:work', {}, 'agent-tool');
    h.incoming('discord:g:chat', '@scout', { addressed: true });
    await new Promise((r) => setImmediate(r));
    assert.doesNotMatch(h.published[0]!.text, /\{[a-z]+\}/);
    assert.ok(DEFAULT_AUTOREPLY.includes('{remaining}'));
  });
});

describe('focus: end + backlog', () => {
  it('delivers per-channel dumps capped to backlogCap (newest kept), counts the rest, hints only real tools, wakes the resident', () => {
    const h = harness({ tools: ['channel_open', 'think'] });
    h.coordinator.enter('discord:g:work', { backlogCap: 2 }, 'agent-tool');
    for (let i = 1; i <= 5; i++) h.incoming('discord:g:chat', `chat ${i}`);
    h.incoming('discord:dm:antra', 'dm 1', { addressed: true });
    h.incoming('discord:g:work', 'live');
    const r = h.coordinator.end('agent-tool', 'ended by you');
    assert.ok(r.ok && r.held === 6);
    assert.equal(h.getFocus(), null);
    assert.deepEqual(h.gateStates.at(-1), null);
    assert.deepEqual(h.wakes, ['scout']);

    assert.equal(h.delivered.length, 1);
    const { text, metadata } = h.delivered[0]!;
    assert.equal(metadata?.kind, 'focus-end');
    assert.equal(metadata?.system, true);
    assert.match(text, /^\[Focus ended — ended by you\./);
    assert.match(text, /6 messages held across 2 channels; 1 addressed you/);
    // chat: 5 held, cap 2 → newest two shown, 3 truncated
    assert.match(text, /<focus-backlog channel="#chat \(discord:g:chat\)" messages=5 tz="UTC" truncated=3 \(oldest, not shown\)>/);
    assert.doesNotMatch(text, /chat 3\n/);
    assert.match(text, /someone: chat 4\n.*someone: chat 5\n<\/focus-backlog>/);
    // dm: 1 held, under cap
    assert.match(text, /<focus-backlog channel="#DM: antra \(discord:dm:antra\)" messages=1 tz="UTC">\n.*dm 1\n<\/focus-backlog>/);
    // live focus-channel message never appears in the dump
    assert.doesNotMatch(text, /live/);
    // Hint names channel_open (present) and NOT history--extract (absent).
    assert.match(text, /channel_open \{channelId, backscroll\}/);
    assert.doesNotMatch(text, /history--extract/);
  });

  it('no hint when nothing was truncated; "Nothing was held" when empty', () => {
    const h = harness();
    h.coordinator.enter('discord:g:work', {}, 'agent-tool');
    h.incoming('discord:g:chat', 'one');
    h.coordinator.end('agent-tool', 'x');
    assert.doesNotMatch(h.delivered[0]!.text, /Held messages above/);

    h.coordinator.enter('discord:g:work', {}, 'agent-tool');
    h.coordinator.end('agent-tool', 'x');
    assert.match(h.delivered[1]!.text, /Nothing was held\.\]$/);
  });

  it('ending when not focused is an error, not a crash', () => {
    const h = harness();
    assert.equal(h.coordinator.end('agent-tool', 'x').ok, false);
  });
});

describe('focus: check', () => {
  it('status tallies held per channel; peek renders without releasing', () => {
    const h = harness();
    h.coordinator.enter('discord:g:work', {}, 'agent-tool');
    h.incoming('discord:g:chat', 'a');
    h.incoming('discord:g:chat', '@scout b', { addressed: true });
    h.incoming('discord:dm:antra', 'c');
    const s = h.coordinator.status();
    assert.equal(s.focused, true);
    assert.deepEqual(s.held?.map((x) => [x.channelId, x.messages, x.addressed]), [
      ['discord:g:chat', 2, 1], ['discord:dm:antra', 1, 0],
    ]);
    const p = h.coordinator.peek('discord:g:chat', 1);
    assert.ok(p.ok && p.total === 2);
    assert.match(p.text, /truncated=1/);
    assert.match(p.text, /@scout b/);
    // Peeking released nothing: end still delivers both.
    h.coordinator.end('agent-tool', 'x');
    assert.match(h.delivered[0]!.text, /messages=2 tz="UTC">/);
  });

  it('tool surface: check while unfocused reports focused:false', () => {
    const h = harness();
    assert.deepEqual(h.coordinator.handleTool({ mode: 'check' }), { success: true, data: { focused: false } });
    assert.equal(h.coordinator.handleTool({ mode: 'enter' }).success, false);
    assert.equal(h.coordinator.handleTool({ mode: 'bogus' }).success, false);
  });
});

describe('focus: re-target', () => {
  it('delivers the new channel\'s held backlog now, keeps the epoch, and does not deliver it again at end', () => {
    const h = harness();
    h.coordinator.enter('discord:g:work', {}, 'agent-tool');
    const epoch = h.getFocus()!.epochId;
    h.incoming('discord:g:chat', 'chat 1');
    h.incoming('discord:g:chat', 'chat 2');
    h.incoming('discord:dm:antra', 'dm 1');
    const r = h.coordinator.enter('discord:g:chat', {}, 'agent-tool');
    assert.ok(r.ok && r.retargeted);
    assert.equal(h.getFocus()!.epochId, epoch);
    assert.equal(h.getFocus()!.channelId, 'discord:g:chat');
    assert.equal(h.delivered.length, 1);
    assert.match(h.delivered[0]!.text, /^\[Focus re-targeted: #work \(discord:g:work\) → #chat \(discord:g:chat\)/);
    assert.match(h.delivered[0]!.text, /messages=2 tz="UTC">/);
    // Now chat is live and work is held.
    assert.equal(h.incoming('discord:g:chat', 'chat 3'), null);
    assert.ok(h.incoming('discord:g:work', 'work 1'));
    h.coordinator.end('agent-tool', 'x');
    const endText = h.delivered[1]!.text;
    assert.doesNotMatch(endText, /chat 1|chat 2|chat 3/);
    assert.match(endText, /dm 1/);
    assert.match(endText, /work 1/);
    assert.match(endText, /2 messages held across 2 channels/);
  });
});

describe('focus: duration + resume', () => {
  it('duration is clamped to [60, max] and defaults from config', () => {
    const h = harness({ maxDurationSeconds: 600 });
    const before = Date.now();
    const r1 = h.coordinator.enter('discord:g:work', { durationSeconds: 5 }, 't');
    assert.ok(r1.ok);
    assert.ok(r1.params.expiresAtMs - before >= 60_000 - 5 && r1.params.expiresAtMs - before <= 61_000);
    h.coordinator.end('t', 'x');
    const r2 = h.coordinator.enter('discord:g:work', { durationSeconds: 99_999 }, 't');
    assert.ok(r2.ok);
    assert.ok(r2.params.expiresAtMs - Date.now() <= 600_000);
    h.coordinator.stop();
  });

  it('a deadline that passed while the host was down ends focus at resume, with the dump', () => {
    const h = harness();
    // Persisted epoch from a previous process, already expired, with held traffic.
    const params: FocusParams = {
      epochId: 'old', serverId: 'discord', channelId: 'discord:g:work',
      startedAtMs: Date.now() - 3_600_000, startedAtSequence: 0,
      expiresAtMs: Date.now() - 1000, backlogCap: 3,
    };
    (h as unknown as { stored: StoredMessage[] }).stored.push({
      id: 'x1', sequence: 1, participant: 'user', timestamp: new Date(),
      content: [{ type: 'text', text: 'while you were away' }],
      metadata: { channelId: 'discord:g:chat', serverId: 'discord', focusHeld: { epochId: 'old' } } as StoredMessage['metadata'],
    });
    (h.coordinator as unknown as { channelRegistry: { setFocus: (p: FocusParams) => void } })
      .channelRegistry.setFocus(params);
    h.coordinator.resume();
    assert.equal(h.getFocus(), null);
    assert.match(h.delivered[0]!.text, /deadline elapsed while the host was down/);
    assert.match(h.delivered[0]!.text, /while you were away/);
    assert.deepEqual(h.wakes, ['scout']);
  });

  it('a live deadline re-arms and rebuilds the autoreply memory from stamps', async () => {
    const h = harness();
    const params: FocusParams = {
      epochId: 'live', serverId: 'discord', channelId: 'discord:g:work',
      startedAtMs: Date.now(), startedAtSequence: 0,
      expiresAtMs: Date.now() + 60_000, backlogCap: 3,
    };
    h.stored.push({
      id: 'x1', sequence: 1, participant: 'user', timestamp: new Date(),
      content: [{ type: 'text', text: '@scout' }],
      metadata: {
        channelId: 'discord:g:chat', serverId: 'discord', author: { id: 'A', name: 'a' },
        tags: ['chat:addressed'], focusHeld: { epochId: 'live', autoReplied: true },
      } as StoredMessage['metadata'],
    });
    (h.coordinator as unknown as { channelRegistry: { setFocus: (p: FocusParams) => void } })
      .channelRegistry.setFocus(params);
    h.coordinator.resume();
    assert.equal(h.getFocus()?.epochId, 'live');
    assert.deepEqual(h.gateStates.at(-1)?.epochId, 'live');
    // Same author, same channel: no second reply after restart.
    h.incoming('discord:g:chat', '@scout again', { addressed: true, authorId: 'A' });
    await new Promise((r) => setImmediate(r));
    assert.equal(h.published.length, 0);
    h.coordinator.stop();
  });
});

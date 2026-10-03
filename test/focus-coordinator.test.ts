/**
 * FocusCoordinator — unit tests against stub registry/hooks.
 *
 * Covers: hold predicate on (serverId, channelId), autoreply once per
 * (channel, author) per epoch and only where the host may speak, end dump
 * with per-channel cap + backscroll hint naming only tools the resident
 * has, deferred (mid-turn) held messages in the backlog, re-target
 * (release + no double delivery), duration/cap clamps incl. fractional
 * config maxima, tune-out refusal, disabled-config teardown, expiry at
 * resume, media placeholders.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import {
  FocusCoordinator, DEFAULT_AUTOREPLY, resolveFocusLimits, buildFocusToolDefinition,
  type FocusFrameworkHooks, type FocusConfig, type DeferredMessageView,
} from '../src/focus/coordinator.js';
import type { ChannelRegistry, FocusParams } from '../src/mcpl/channel-registry.js';

/** Every coordinator built here; armed expiry timers are cleared at the end so
 *  no test leaves a live timer keeping the runner alive. */
const built: FocusCoordinator[] = [];
after(() => { for (const c of built) c.stop(); });

const CHANNELS: Array<{ serverId: string; id: string; label: string; open: boolean; dm?: boolean }> = [
  { serverId: 'discord', id: 'discord:g:work', label: 'work', open: true },
  { serverId: 'discord', id: 'discord:g:chat', label: 'chat', open: true },
  { serverId: 'discord', id: 'discord:g:lurk', label: 'lurk', open: false },
  { serverId: 'discord', id: 'discord:dm:antra', label: 'DM: antra', open: false, dm: true },
  // Same id string as `work`, on another server.
  { serverId: 'slack', id: 'discord:g:work', label: 'imposter', open: true },
  { serverId: 'slack', id: 'slack:general', label: 'general', open: true },
];

function harness(opts?: {
  tools?: string[]; config?: Partial<FocusConfig>; tunedOut?: string[]; publishFails?: boolean;
}) {
  let focus: FocusParams | null = null;
  const stored: StoredMessage[] = [];
  const deferredQueue: DeferredMessageView[] = [];
  const delivered: Array<{ participant: string; text: string; metadata?: Record<string, unknown> }> = [];
  const published: Array<{ serverId: string; channelId: string; text: string }> = [];
  const wakes: string[] = [];
  const gateStates: Array<FocusParams | null> = [];
  let seq = 0;
  let publishFails = opts?.publishFails ?? false;

  const registry = {
    getFocus: () => focus,
    setFocus: (p: FocusParams | null) => { focus = p; },
    resolveChannel: (channelId: string, serverId?: string) => {
      const matches = CHANNELS.filter((c) => c.id === channelId && (!serverId || c.serverId === serverId));
      if (matches.length === 0) return { error: `Channel not found: ${channelId}` };
      if (matches.length > 1) return { error: `Channel id is ambiguous across MCPL servers: ${channelId}. Include serverId.` };
      return { entry: { serverId: matches[0]!.serverId, channelId: matches[0]!.id, label: matches[0]!.label } };
    },
    listChannelsRaw: () => CHANNELS.map((c) => ({ serverId: c.serverId, descriptor: { id: c.id, label: c.label } })),
  } as unknown as ChannelRegistry;

  const hooks: FocusFrameworkHooks = {
    addMessage: (participant, content, metadata) => {
      const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      delivered.push({ participant, text, metadata });
      return { id: `d-${delivered.length}`, deferred: false };
    },
    requestInference: (agentName) => { wakes.push(agentName); },
    primaryName: () => 'scout',
    getStoredMessages: () => stored,
    getDeferredMessages: () => deferredQueue,
    currentSequence: () => seq,
    channelLabel: (s, c) => CHANNELS.find((x) => x.serverId === s && x.id === c)?.label,
    publish: async (serverId, channelId, text) => {
      if (publishFails) return { success: false, error: 'boom' };
      published.push({ serverId, channelId, text });
      return { success: true };
    },
    canAutoReplyInto: (s, c) => {
      const ch = CHANNELS.find((x) => x.serverId === s && x.id === c);
      return !!ch && (ch.open || !!ch.dm);
    },
    isTunedOut: (s, c) => (opts?.tunedOut ?? []).includes(`${s}:${c}`),
    timeZone: () => 'UTC',
    availableToolNames: () => opts?.tools ?? ['history--extract', 'channel_open'],
    isForkRouted: () => false,
    onFocusChanged: (s) => { gateStates.push(s); },
    emitTrace: () => {},
  };
  const coordinator = new FocusCoordinator(registry, {
    enabled: true,
    defaultBacklogCap: 3,
    ...(opts?.config ?? {}),
  }, hooks);
  built.push(coordinator);

  const mkMeta = (serverId: string, channelId: string, o?: { addressed?: boolean; authorId?: string }, stamp?: unknown) => ({
    channelId, serverId, author: { id: o?.authorId ?? 'U1', name: 'someone' },
    ...(o?.addressed ? { tags: ['chat:mention', 'chat:addressed'] } : {}),
    ...(stamp ? { focusHeld: stamp } : {}),
  }) as StoredMessage['metadata'];

  /** Simulate the framework's ingestion: consult, stamp, store. */
  const incoming = (channelId: string, text: string, o?: { addressed?: boolean; authorId?: string; serverId?: string; content?: ContentBlock[] }) => {
    const serverId = o?.serverId ?? 'discord';
    const stamp = coordinator.onIncoming(serverId, channelId, `m${++seq}`,
      o?.addressed ? ['chat:mention', 'chat:addressed'] : [], { id: o?.authorId ?? 'U1', name: 'someone' });
    stored.push({
      id: `m${seq}`, sequence: seq, participant: 'user', timestamp: new Date(seq * 1000),
      content: o?.content ?? [{ type: 'text', text }],
      metadata: mkMeta(serverId, channelId, o, stamp),
    });
    return stamp;
  };
  /** A held message that arrived mid-turn: stamped, but parked in the deferred queue. */
  const incomingDeferred = (channelId: string, text: string, o?: { addressed?: boolean; authorId?: string }) => {
    const stamp = coordinator.onIncoming('discord', channelId, `m${++seq}`,
      o?.addressed ? ['chat:mention', 'chat:addressed'] : [], { id: o?.authorId ?? 'U1', name: 'someone' });
    deferredQueue.push({ participant: 'user', content: [{ type: 'text', text }], metadata: mkMeta('discord', channelId, o, stamp) as Record<string, unknown> });
    return stamp;
  };

  return {
    coordinator, incoming, incomingDeferred, delivered, published, wakes, gateStates, stored, deferredQueue,
    getFocus: () => focus, setFocus: (p: FocusParams | null) => { focus = p; },
    setPublishFails: (v: boolean) => { publishFails = v; },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

describe('focus: hold predicate', () => {
  it('not focused → nothing is held', () => {
    const h = harness();
    assert.equal(h.incoming('discord:g:chat', 'hi'), null);
  });

  it('focus channel passes; every other channel and DM is held and stamped with the epoch', () => {
    const h = harness();
    const r = h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool');
    assert.ok(r.ok);
    assert.equal(h.incoming('discord:g:work', 'on topic'), null);
    const held = h.incoming('discord:g:chat', 'off topic');
    assert.equal(held?.epochId, h.getFocus()!.epochId);
    const dm = h.incoming('discord:dm:antra', 'psst');
    assert.equal(dm?.epochId, h.getFocus()!.epochId);
    assert.equal(h.gateStates.length, 1);
    assert.equal(h.gateStates[0]?.channelId, 'discord:g:work');
  });

  it('identity is (serverId, channelId): the same id string on another server is held', () => {
    const h = harness();
    assert.ok(h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool').ok);
    const imposter = h.incoming('discord:g:work', 'same id, other server', { serverId: 'slack' });
    assert.ok(imposter, 'held');
    assert.equal(h.incoming('discord:g:work', 'the real one', { serverId: 'discord' }), null);
  });

  it('an ambiguous channel id is refused until serverId disambiguates; unknown channel refused', () => {
    const h = harness();
    const ambiguous = h.coordinator.enter('discord:g:work', {}, 'agent-tool');
    assert.equal(ambiguous.ok, false);
    assert.match((ambiguous as { error: string }).error, /ambiguous/);
    assert.ok(h.coordinator.enter('discord:g:work', { serverId: 'slack' }, 'agent-tool').ok);
    assert.equal(h.getFocus()!.serverId, 'slack');
    const h2 = harness();
    assert.equal(h2.coordinator.enter('discord:g:nope', {}, 'agent-tool').ok, false);
  });

  it('a tuned-out channel cannot be focused (its traffic goes to the subconscious)', () => {
    const h = harness({ tunedOut: ['discord:discord:g:chat'] });
    const r = h.coordinator.enter('discord:g:chat', {}, 'agent-tool');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /tuned out/);
  });

  it('disabled configuration: enter refused; a stale persisted epoch ends at resume with its dump', () => {
    const h = harness({ config: { enabled: false } });
    assert.match((h.coordinator.enter('discord:g:chat', {}, 'x') as { error: string }).error, /disabled/);
    h.setFocus({
      epochId: 'stale', serverId: 'discord', channelId: 'discord:g:work',
      startedAtMs: Date.now() - 1000, startedAtSequence: 0, expiresAtMs: Date.now() + 60_000, backlogCap: 3,
    });
    h.stored.push({
      id: 'x1', sequence: 1, participant: 'user', timestamp: new Date(),
      content: [{ type: 'text', text: 'held before the switch flipped' }],
      metadata: { channelId: 'discord:g:chat', serverId: 'discord', focusHeld: { epochId: 'stale' } } as StoredMessage['metadata'],
    });
    h.coordinator.resume();
    assert.equal(h.getFocus(), null);
    assert.match(h.delivered[0]!.text, /disabled in the configuration/);
    assert.match(h.delivered[0]!.text, /held before the switch flipped/);
    assert.deepEqual(h.wakes, ['scout']);
  });
});

describe('focus: autoreply', () => {
  it('replies once per (channel, author) per epoch, to addressed messages only, server-qualified', async () => {
    const h = harness();
    h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool');
    h.incoming('discord:g:chat', 'ambient', { authorId: 'A' });
    const first = h.incoming('discord:g:chat', '@scout?', { addressed: true, authorId: 'A' });
    const second = h.incoming('discord:g:chat', '@scout??', { addressed: true, authorId: 'A' });
    const other = h.incoming('discord:g:chat', '@scout', { addressed: true, authorId: 'B' });
    const elsewhere = h.incoming('discord:dm:antra', 'dm', { addressed: true, authorId: 'A' });
    await settle();
    assert.deepEqual(h.published.map((p) => [p.serverId, p.channelId]),
      [['discord', 'discord:g:chat'], ['discord', 'discord:g:chat'], ['discord', 'discord:dm:antra']]);
    assert.equal(first?.autoReplied, true);
    assert.equal(second?.autoReplied, undefined);
    assert.equal(other?.autoReplied, true);
    assert.equal(elsewhere?.autoReplied, true);
    assert.match(h.published[0]!.text, /scout is in focus mode/);
    assert.match(h.published[0]!.text, /^\[Automatic reply\]/);
  });

  it('never speaks in a channel the resident is not open in; DMs are fine', async () => {
    const h = harness();
    h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool');
    const lurk = h.incoming('discord:g:lurk', '@scout from a room you never joined', { addressed: true });
    const dm = h.incoming('discord:dm:antra', 'dm', { addressed: true });
    await settle();
    assert.ok(lurk && !lurk.autoReplied, 'held, counted, reply-less');
    assert.equal(dm?.autoReplied, true);
    assert.deepEqual(h.published.map((p) => p.channelId), ['discord:dm:antra']);
    h.coordinator.end('t', 'x');
    assert.match(h.delivered[0]!.text, /2 addressed you \(1 got the automatic reply\)/);
  });

  it('a failed publish releases the (channel, author) allowance so the next mention retries', async () => {
    const h = harness({ publishFails: true });
    h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool');
    h.incoming('discord:g:chat', '@scout 1', { addressed: true, authorId: 'A' });
    await settle();
    assert.equal(h.published.length, 0);
    h.setPublishFails(false);
    h.incoming('discord:g:chat', '@scout 2', { addressed: true, authorId: 'A' });
    await settle();
    assert.equal(h.published.length, 1, 'retried after the failure');
    h.incoming('discord:g:chat', '@scout 3', { addressed: true, authorId: 'A' });
    await settle();
    assert.equal(h.published.length, 1, 'and then once is once');
  });

  it('autoReply: false suppresses the reply but still holds; the end notice says so', async () => {
    const h = harness({ config: { autoReply: false } });
    h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool');
    const held = h.incoming('discord:g:chat', '@scout', { addressed: true });
    await settle();
    assert.ok(held);
    assert.equal(h.published.length, 0);
    h.coordinator.end('t', 'x');
    assert.match(h.delivered[0]!.text, /1 addressed you \(no automatic reply was sent\)/);
  });

  it('the default template carries no placeholder residue', async () => {
    const h = harness();
    h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool');
    h.incoming('discord:g:chat', '@scout', { addressed: true });
    await settle();
    assert.doesNotMatch(h.published[0]!.text, /\{[a-z]+\}/);
    assert.ok(DEFAULT_AUTOREPLY.includes('{remaining}'));
  });
});

describe('focus: end + backlog', () => {
  it('delivers per-channel dumps capped to backlogCap (newest kept), counts the rest, hints only real tools, wakes the resident', () => {
    const h = harness({ tools: ['channel_open', 'think'] });
    h.coordinator.enter('discord:g:work', { backlogCap: 2, serverId: 'discord' }, 'agent-tool');
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
    assert.match(text, /<focus-backlog channel="#chat \(discord:g:chat\)" messages=5 tz="UTC" truncated=3 \(oldest, not shown\)>/);
    assert.doesNotMatch(text, /chat 3\n/);
    assert.match(text, /someone: chat 4\n.*someone: chat 5\n<\/focus-backlog>/);
    assert.match(text, /<focus-backlog channel="#DM: antra \(discord:dm:antra\)" messages=1 tz="UTC">\n.*dm 1\n<\/focus-backlog>/);
    assert.doesNotMatch(text, /live/);
    assert.match(text, /channel_open \{channelId, backscroll\}/);
    assert.doesNotMatch(text, /history--extract/);
  });

  it('held messages still deferred behind the current turn are in the dump', () => {
    const h = harness();
    h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool');
    h.incoming('discord:g:chat', 'stored one');
    h.incomingDeferred('discord:g:chat', 'arrived mid-turn');
    const s = h.coordinator.status();
    assert.equal(s.held?.[0]?.messages, 2, 'check counts it too');
    const r = h.coordinator.end('t', 'x');
    assert.ok(r.ok && r.held === 2);
    assert.match(h.delivered[0]!.text, /messages=2 tz="UTC">\n\[\d\d:\d\d\] someone: stored one\n\[arrived mid-turn\] someone: arrived mid-turn\n<\/focus-backlog>/);
  });

  it('media blocks are named, not dropped', () => {
    const h = harness();
    h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool');
    h.incoming('discord:g:chat', '', { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } } as unknown as ContentBlock] });
    h.incoming('discord:g:chat', 'look', { content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } } as unknown as ContentBlock, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } } as unknown as ContentBlock] });
    h.coordinator.end('t', 'x');
    assert.match(h.delivered[0]!.text, /someone: \[\+1 image\]\n/);
    assert.match(h.delivered[0]!.text, /someone: look \[\+2 images\]\n/);
  });

  it('no hint when nothing was truncated; "Nothing was held" when empty', () => {
    const h = harness();
    h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool');
    h.incoming('discord:g:chat', 'one');
    h.coordinator.end('agent-tool', 'x');
    assert.doesNotMatch(h.delivered[0]!.text, /Held messages above/);

    h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool');
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
    h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool');
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
    h.coordinator.end('agent-tool', 'x');
    assert.match(h.delivered[0]!.text, /messages=2 tz="UTC">/);
  });

  it('tool surface: check while unfocused reports focused:false; serverId threads through enter', () => {
    const h = harness();
    assert.deepEqual(h.coordinator.handleTool({ mode: 'check' }), { success: true, data: { focused: false } });
    assert.equal(h.coordinator.handleTool({ mode: 'enter' }).success, false);
    assert.equal(h.coordinator.handleTool({ mode: 'bogus' }).success, false);
    const r = h.coordinator.handleTool({ mode: 'enter', channelId: 'discord:g:work', serverId: 'slack' });
    assert.equal(r.success, true);
    assert.equal((r.data as { serverId: string }).serverId, 'slack');
  });
});

describe('focus: re-target', () => {
  it('delivers the new channel\'s stored backlog now, keeps the epoch, and does not deliver it again at end', () => {
    const h = harness();
    h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool');
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
    assert.equal(h.incoming('discord:g:chat', 'chat 3'), null);
    assert.ok(h.incoming('discord:g:work', 'work 1'));
    h.coordinator.end('agent-tool', 'x');
    const endText = h.delivered[1]!.text;
    assert.doesNotMatch(endText, /chat 1|chat 2|chat 3/);
    assert.match(endText, /dm 1/);
    assert.match(endText, /work 1/);
    assert.match(endText, /2 messages held across 2 channels/);
  });

  it('a truncated re-target dump carries the history hint; deferred held messages wait for the end', () => {
    const h = harness({ config: { defaultBacklogCap: 1 } });
    h.coordinator.enter('discord:g:work', { serverId: 'discord' }, 'agent-tool');
    h.incoming('discord:g:chat', 'chat 1');
    h.incoming('discord:g:chat', 'chat 2');
    h.incomingDeferred('discord:g:chat', 'chat 3 mid-turn');
    const r = h.coordinator.enter('discord:g:chat', {}, 'agent-tool');
    assert.ok(r.ok);
    const t = h.delivered[0]!.text;
    assert.match(t, /messages=2 tz="UTC" truncated=1/);
    assert.match(t, /Held messages above the per-channel cap of 1/);
    assert.doesNotMatch(t, /mid-turn/);
    h.coordinator.end('t', 'x');
    assert.match(h.delivered[1]!.text, /chat 3 mid-turn/, 'the deferred one arrives at unfocus');
    assert.doesNotMatch(h.delivered[1]!.text, /chat 1|chat 2/);
  });
});

describe('focus: limits', () => {
  it('config maxima are floored/capped and integers; defaults clamp into range', () => {
    assert.deepEqual(resolveFocusLimits({ enabled: true }), {
      minDuration: 60, maxDuration: 14_400, defaultDuration: 1800, maxCap: 200, defaultCap: 20,
    });
    const odd = resolveFocusLimits({ enabled: true, maxDurationSeconds: 0.5, maxBacklogCap: 0.5, defaultDurationSeconds: 1e308, defaultBacklogCap: 7 });
    assert.deepEqual(odd, { minDuration: 60, maxDuration: 60, defaultDuration: 60, maxCap: 0, defaultCap: 0 });
    const huge = resolveFocusLimits({ enabled: true, maxDurationSeconds: 1e308 });
    assert.equal(huge.maxDuration, 7 * 24 * 3600);
    const desc = buildFocusToolDefinition({ enabled: true, maxDurationSeconds: 10 }).inputSchema.properties!.durationSeconds as { description: string };
    assert.match(desc.description, /min 60, max 60/);
  });

  it('a fractional configured cap cannot deliver the whole backlog', () => {
    const h = harness({ config: { maxBacklogCap: 0.5 } });
    h.coordinator.enter('discord:g:work', { backlogCap: 5, serverId: 'discord' }, 'agent-tool');
    assert.equal(h.getFocus()!.backlogCap, 0);
    h.incoming('discord:g:chat', 'a');
    h.incoming('discord:g:chat', 'b');
    h.coordinator.end('t', 'x');
    assert.match(h.delivered[0]!.text, /messages=2 tz="UTC" truncated=2 \(oldest, not shown\)>\n\n<\/focus-backlog>/);
  });

  it('duration is clamped to [60, max] and defaults from config', () => {
    const h = harness({ config: { maxDurationSeconds: 600 } });
    const before = Date.now();
    const r1 = h.coordinator.enter('discord:g:work', { durationSeconds: 5, serverId: 'discord' }, 't');
    assert.ok(r1.ok);
    assert.ok(r1.params.expiresAtMs - before >= 60_000 - 5 && r1.params.expiresAtMs - before <= 61_000);
    h.coordinator.end('t', 'x');
    const r2 = h.coordinator.enter('discord:g:work', { durationSeconds: 99_999, serverId: 'discord' }, 't');
    assert.ok(r2.ok);
    assert.ok(r2.params.expiresAtMs - Date.now() <= 600_000);
  });
});

describe('focus: resume', () => {
  it('a deadline that passed while the host was down ends focus at resume, with the dump', () => {
    const h = harness();
    const params: FocusParams = {
      epochId: 'old', serverId: 'discord', channelId: 'discord:g:work',
      startedAtMs: Date.now() - 3_600_000, startedAtSequence: 0,
      expiresAtMs: Date.now() - 1000, backlogCap: 3,
    };
    h.stored.push({
      id: 'x1', sequence: 1, participant: 'user', timestamp: new Date(),
      content: [{ type: 'text', text: 'while you were away' }],
      metadata: { channelId: 'discord:g:chat', serverId: 'discord', focusHeld: { epochId: 'old' } } as StoredMessage['metadata'],
    });
    h.setFocus(params);
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
    h.setFocus(params);
    h.coordinator.resume();
    assert.equal(h.getFocus()?.epochId, 'live');
    assert.deepEqual(h.gateStates.at(-1)?.epochId, 'live');
    h.incoming('discord:g:chat', '@scout again', { addressed: true, authorId: 'A' });
    await settle();
    assert.equal(h.published.length, 0);
  });

  it('a focus dump restored into the deferred queue re-wakes the resident (its wake died with the old process)', () => {
    const h = harness();
    h.deferredQueue.push({ participant: 'user', content: [{ type: 'text', text: '[Focus ended — …]' }], metadata: { system: true, kind: 'focus-end', epochId: 'gone' } });
    h.coordinator.resume();
    assert.deepEqual(h.wakes, ['scout']);
    assert.equal(h.getFocus(), null);
  });
});

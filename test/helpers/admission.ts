/**
 * Shared harness for the admission / tune-out e2e tests: the RFC-006
 * loopback MCPL server, a mocked model, explicit event-loop driving.
 */
import assert from 'node:assert/strict';
import { fixture, eventually, TS } from './coalescing-fixture.js';
import { GateModule, waitCall, say } from './dendrite.js';
import type { TuneOutCoordinator } from '../../src/tune-out/coordinator.js';

export type Stored = { participant: string; content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> };
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export type Internals = {
  tuneOutCoordinator: TuneOutCoordinator | null;
  channelRegistry: {
    getDefaultPublishChannel(): string | null;
    resolveLocus(agent: string): string | null;
    getDesiredState(serverId: string, channelId: string): string | undefined;
    getTuneOutState(serverId: string, channelId: string): { params: { epochId: string } } | null;
    channels: Map<string, unknown>;
  };
  eventGate: { debounceTimers: Map<string, unknown> } | null;
  pendingRequests: Array<{ agentName: string; reason: string }>;
  handleTuneOutTool(agentName: string, input: Record<string, unknown>): { success: boolean; error?: string; data?: unknown };
};

export const SUB = { enabled: true, systemPrompt: 'You are the Subconscious. Report briefly.' } as const;
export const internals = (f: Fixture) => f.framework as unknown as Internals;

export const textOf = (m: { content: Array<{ type: string; text?: string }> }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
export const stored = (f: Fixture, agent = 'agent'): Stored[] =>
  f.framework.getAgent(agent)!.getContextManager().getAllMessages() as unknown as Stored[];
export const held = (m: Stored): boolean => !!(m.metadata as { tuneOut?: unknown } | undefined)?.tuneOut;
export const has = (f: Fixture, text: string) => stored(f).some((m) => textOf(m).includes(text));
/** Whether the agent's window holds a row with `text` (#291: a row is stored at once, and enters the window at a point). */
export const inWindow = (f: Fixture, text: string, agent = 'agent'): boolean =>
  (f.framework.getAgent(agent)!.getContextManager().getPresentedMessages() as unknown as Stored[]).some((m) => textOf(m).includes(text));
export const find = (f: Fixture, text: string) => stored(f).find((m) => textOf(m).includes(text))!;
export const AMBIENT = ['chat:ambient', 'chat:from-human'];
export const MENTION = ['chat:mention', 'chat:addressed', 'chat:from-human'];

export function incoming(f: Fixture, channelId: string, messageId: string, text: string, tags = AMBIENT, content?: unknown[]) {
  return f.send('channels/incoming', {
    messages: [{
      channelId, messageId, timestamp: TS, author: { id: 'U1', name: 'antra' }, tags,
      content: content ?? [{ type: 'text', text }],
    }],
  });
}

/** A Discord-shaped DM: it arrives as a push event, since the DM channel is closed. */
export function dm(f: Fixture, eventId: string, text: string) {
  return f.send('push/event', {
    featureSet: 'doc', eventId, timestamp: TS,
    payload: { content: [{ type: 'text', text }] },
    origin: { source: 'discord', channelId: '777', guildId: null, isDM: true, authorId: 'U1', authorName: 'antra', messageId: eventId },
    tags: ['chat:dm', 'chat:addressed', 'chat:from-human'],
  });
}

export async function registerOpen(f: Fixture, ...ids: string[]) {
  await f.send('channels/register', {
    channels: ids.map((id) => ({ id, type: 'discord', label: id, initiallyOpen: true, metadata: { channelType: 'guild_text' } })),
  });
  await eventually(() => ids.every((id) => internals(f).channelRegistry.getDesiredState('editor', id) === 'open'), 'channels open');
}

export function enter(f: Fixture, channelId: string, opts: Record<string, number> = {}) {
  const r = internals(f).tuneOutCoordinator!.enter('editor', channelId, { cadenceSeconds: 3600, maxWakes: 5, ...opts }, 'agent-tool');
  assert.ok(r.ok, `enter ${channelId}: ${(r as { error?: string }).error ?? ''}`);
}

/** Process what the server sent; nothing may wake (no response is scripted). */
export async function settle(f: Fixture): Promise<void> {
  const before = f.membrane.calls.length;
  // A sentinel keeps an unexpected wake from hanging the mock; the count
  // below is the assertion. Unused, it is swallowed by the next scripted turn.
  f.membrane.pushResponse(say('[unexpected wake]'));
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, before, 'nothing woke');
}

/** Run a turn nothing delivered into (a heartbeat) and report the locus it froze. */
export async function channellessTurnLocus(f: Fixture): Promise<string | null> {
  let locus: string | null | undefined;
  const off = f.framework.onTrace((t) => {
    if (t.type === 'inference:started' && (t as { agentName: string }).agentName === 'agent') {
      locus = (t as { channelId?: string }).channelId ?? null;
    }
  });
  try {
    (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'agent', reason: 'heartbeat', source: 'test', timestamp: Date.now(),
    });
    await f.turn();
  } finally { off(); }
  assert.notEqual(locus, undefined, 'the heartbeat turn ran');
  return locus ?? null;
}

/** A resident turn blocked in a tool call, on an open channel. */
export async function blockInTool(f: Fixture, gate: GateModule): Promise<{ loop: Promise<void> }> {
  // The fixture pre-scripts one 'ok'; the mock hands every queued response
  // to the first stream, so start this turn's script from a clean queue.
  f.membrane.responses.length = 0;
  (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
  f.membrane.pushResponse(waitCall('g1'));
  f.membrane.pushResponse(say('done'));
  await incoming(f, 'work', 'w1', 'please wait for me');
  const loop = f.framework.runUntilIdle();
  await eventually(() => gate.entered.has('g1'), 'resident blocked in a tool call');
  return { loop }; // wrapped: an async return would await the loop itself
}


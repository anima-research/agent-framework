/**
 * Clock rows (AgentConfig.clock, src/clock-rows.ts).
 *
 * A clock stands for the tick that fired at the latest boundary of the
 * agent's local wall clock, written lazily before what the window takes
 * next. It reads the boundary's time only where that tick would have stood;
 * after a tool round (nothing can stand between a tool's call and its
 * results) or a reply that spanned the boundary, it reads the time it was
 * written. It never reads earlier than a row before it.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentFramework } from '../src/index.js';
import type { AgentConfig, Module, ModuleContext, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import {
  formatClockText,
  latestBoundary,
  planClock,
  resolveClockConfig,
  type ResolvedClockConfig,
} from '../src/clock-rows.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { forkAgentName } from '../src/mcpl/conversation-router.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

const at = (iso: string): number => Date.parse(iso);
const TEN_MINUTES: ResolvedClockConfig = { intervalSeconds: 600, precision: 'minutes' };

describe('clock config', () => {
  it('takes minutes or seconds, and picks the precision the interval allows', () => {
    assert.deepEqual(resolveClockConfig('a', undefined), undefined);
    assert.deepEqual(resolveClockConfig('a', { intervalMinutes: 10 }), { intervalSeconds: 600, precision: 'minutes' });
    assert.deepEqual(resolveClockConfig('a', { intervalSeconds: 15 }), { intervalSeconds: 15, precision: 'seconds' });
    assert.deepEqual(resolveClockConfig('a', { intervalSeconds: 120 }), { intervalSeconds: 120, precision: 'minutes' });
    assert.deepEqual(
      resolveClockConfig('a', { intervalMinutes: 1, precision: 'seconds' }),
      { intervalSeconds: 60, precision: 'seconds' },
    );
  });

  it('refuses a setting it cannot read as a clock, naming the agent', () => {
    assert.throws(() => resolveClockConfig('Ada', {}), /Agent "Ada" clock takes exactly one of/);
    assert.throws(() => resolveClockConfig('a', { intervalMinutes: 10, intervalSeconds: 600 }), /exactly one/);
    assert.throws(() => resolveClockConfig('a', { intervalMinutes: 0 }), /positive whole number/);
    assert.throws(() => resolveClockConfig('a', { intervalMinutes: 2.5 }), /positive whole number/);
    assert.throws(() => resolveClockConfig('a', { intervalMinutes: 1441 }), /at most a day/);
    assert.throws(() => resolveClockConfig('a', { intervalSeconds: 90, precision: 'minutes' }), /precision 'seconds'/);
    assert.throws(() => resolveClockConfig('a', { intervalMinutes: 5, precision: 'hours' as never }), /'minutes' or 'seconds'/);
    assert.throws(() => resolveClockConfig('a', 10 as never), /must be an object/);
  });
});

describe('clock boundaries', () => {
  it('counts from local midnight in the zone, not from UTC', () => {
    // Kathmandu is UTC+05:45: an hourly boundary is :00 there, :15 in UTC.
    assert.equal(
      latestBoundary(at('2026-10-21T05:00:00Z'), 3600, 'Asia/Kathmandu'),
      at('2026-10-21T04:15:00Z'),
    );
    assert.equal(latestBoundary(at('2026-10-21T10:51:30Z'), 600, 'UTC'), at('2026-10-21T10:50:00Z'));
    assert.equal(latestBoundary(at('2026-10-21T10:50:00Z'), 600, 'UTC'), at('2026-10-21T10:50:00Z'),
      'a boundary is its own latest');
  });

  it('keeps wall-clock boundaries across a DST change', () => {
    // New York springs forward 2026-03-08 02:00 EST -> 03:00 EDT. Four-hour
    // boundaries from local midnight: 00:00 EST (05:00Z), 04:00 EDT (08:00Z).
    assert.equal(
      latestBoundary(at('2026-03-08T07:30:00Z'), 4 * 3600, 'America/New_York'),
      at('2026-03-08T05:00:00Z'),
      '03:30 EDT: the latest boundary is midnight EST, 2.5 hours back, not 3.5',
    );
    // Hourly: 02:00 never happens that day.
    assert.equal(
      latestBoundary(at('2026-03-08T06:59:00Z'), 3600, 'America/New_York'),
      at('2026-03-08T06:00:00Z'),
    );
    assert.equal(
      latestBoundary(at('2026-03-08T07:00:30Z'), 3600, 'America/New_York'),
      at('2026-03-08T07:00:00Z'),
    );
    // Falls back 2026-11-01 02:00 EDT -> 01:00 EST: 01:00 happens twice, and
    // the second one is the latest once it has passed.
    assert.equal(
      latestBoundary(at('2026-11-01T05:30:00Z'), 3600, 'America/New_York'),
      at('2026-11-01T05:00:00Z'),
    );
    assert.equal(
      latestBoundary(at('2026-11-01T06:30:00Z'), 3600, 'America/New_York'),
      at('2026-11-01T06:00:00Z'),
    );
  });
});

describe('clock boundaries against every second around real offset changes', () => {
  // Ground truth with no arithmetic: every whole second whose wall clock in
  // the zone reads a whole multiple of the interval since local midnight.
  // latestBoundary must give the latest such second at or before `now`, for
  // every minute (and half minute) within four hours of each change: a
  // repeated hour, a skipped one, a skipped local midnight, a zone east of
  // UTC+12 and a half-hour change.
  const changes = [
    { zone: 'Europe/Berlin', at: '2026-10-25T01:00:00Z' }, // 03:00 CEST -> 02:00 CET
    { zone: 'America/New_York', at: '2026-03-08T07:00:00Z' }, // 02:00 EST -> 03:00 EDT
    { zone: 'Pacific/Auckland', at: '2026-04-04T14:00:00Z' }, // 03:00 NZDT (UTC+13) -> 02:00 NZST
    { zone: 'America/Santiago', at: '2026-09-06T04:00:00Z' }, // midnight -04 -> 01:00 -03
    { zone: 'America/Havana', at: '2026-03-08T05:00:00Z' }, // midnight CST -> 01:00 CDT
    { zone: 'Australia/Lord_Howe', at: '2026-04-04T15:00:00Z' }, // 02:00 +11 -> 01:30 +10:30
  ];
  const intervals = [60, 7 * 60, 10 * 60, 45 * 60, 50 * 60];

  for (const change of changes) {
    it(`${change.zone} around ${change.at}`, () => {
      const t = at(change.at);
      const wall = new Intl.DateTimeFormat('en-CA', {
        timeZone: change.zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      });
      const from = t - 6 * 3_600_000;
      const secondsOfDay: number[] = [];
      for (let s = from; s <= t + 4 * 3_600_000; s += 1000) {
        const parts = wall.formatToParts(new Date(s));
        const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
        secondsOfDay.push(get('hour') * 3600 + get('minute') * 60 + get('second'));
      }
      const wrong: string[] = [];
      for (const interval of intervals) {
        const boundaries = secondsOfDay.flatMap((sod, i) => (sod % interval === 0 ? [from + i * 1000] : []));
        for (let now = t - 4 * 3_600_000; now <= t + 4 * 3_600_000; now += 30_000) {
          const expected = boundaries.filter((b) => b <= now).at(-1)!;
          const got = latestBoundary(now, interval, change.zone);
          if (got !== expected) {
            wrong.push(`${interval}s at ${new Date(now).toISOString()}: ${new Date(got).toISOString()}, not ${new Date(expected).toISOString()}`);
          }
        }
      }
      assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} wrong`);
    });
  }
});

describe('clock text', () => {
  it('shows the time zone, the date when asked, and seconds when the precision is seconds', () => {
    const t = at('2026-07-15T08:50:00Z');
    assert.equal(formatClockText(t, 'Europe/Berlin', 'minutes', false), 'Clock: 10:50 Europe/Berlin (UTC+02:00)');
    assert.equal(
      formatClockText(t, 'Europe/Berlin', 'minutes', true),
      'Clock: Wednesday 2026-07-15, 10:50 Europe/Berlin (UTC+02:00)',
    );
    assert.equal(
      formatClockText(at('2026-07-15T08:50:07Z'), 'Europe/Berlin', 'seconds', false),
      'Clock: 10:50:07 Europe/Berlin (UTC+02:00)',
    );
    assert.equal(formatClockText(t, 'UTC', 'minutes', false), 'Clock: 08:50 UTC');
    assert.equal(formatClockText(t, 'Etc/UTC', 'minutes', false), 'Clock: 08:50 UTC', 'a container\'s usual TZ');
    assert.equal(formatClockText(t, 'America/St_Johns', 'minutes', false), 'Clock: 06:20 America/St_Johns (UTC-02:30)');
  });
});

describe('planning a clock', () => {
  const plan = (args: { now: string; newest?: string; lastClock?: string; config?: ResolvedClockConfig }) =>
    planClock({
      now: at(args.now),
      newestRowAt: args.newest ? at(args.newest) : undefined,
      lastClockAt: args.lastClock ? at(args.lastClock) : undefined,
      config: args.config ?? TEN_MINUTES,
      zone: 'UTC',
    });
  const text = (p: ReturnType<typeof plan>) => (p?.content[0] as { text: string } | undefined)?.text;

  it('reads the boundary where its tick would have stood', () => {
    const p = plan({ now: '2026-10-21T10:51:00Z', newest: '2026-10-21T10:45:00Z', lastClock: '2026-10-21T10:40:00Z' });
    assert.equal(text(p), 'Clock: 10:50 UTC');
    assert.deepEqual(p?.stamp, { at: at('2026-10-21T10:50:00Z'), onBoundary: true, zone: 'UTC' });
  });

  it('writes only the latest of several boundaries', () => {
    const p = plan({ now: '2026-10-21T11:23:00Z', newest: '2026-10-21T10:45:00Z', lastClock: '2026-10-21T10:40:00Z' });
    assert.equal(text(p), 'Clock: 11:20 UTC');
  });

  it('reads the time it is written when a row after the boundary comes first', () => {
    // A tool ran over 10:50; its results (10:52) must follow its call.
    const p = plan({ now: '2026-10-21T10:52:05Z', newest: '2026-10-21T10:52:04Z', lastClock: '2026-10-21T10:40:00Z' });
    assert.equal(text(p), 'Clock: 10:52 UTC');
    assert.equal(p?.stamp.onBoundary, false);
    assert.equal(p?.stamp.at, at('2026-10-21T10:52:05Z'));
  });

  it('never reads earlier than the row it follows', () => {
    const p = plan({ now: '2026-10-21T10:52:05Z', newest: '2026-10-21T10:53:00Z', lastClock: '2026-10-21T10:40:00Z' });
    assert.equal(p?.stamp.at, at('2026-10-21T10:53:00Z'));
  });

  it('writes nothing until a boundary passes the last clock', () => {
    assert.equal(plan({ now: '2026-10-21T10:59:59Z', newest: '2026-10-21T10:55:00Z', lastClock: '2026-10-21T10:52:05Z' }), null);
    assert.equal(text(plan({ now: '2026-10-21T11:00:01Z', newest: '2026-10-21T10:55:00Z', lastClock: '2026-10-21T10:52:05Z' })),
      'Clock: 11:00 UTC');
  });

  it('shows the date when the day has changed since the last clock', () => {
    assert.equal(
      text(plan({ now: '2026-10-22T00:01:00Z', newest: '2026-10-21T23:55:00Z', lastClock: '2026-10-21T23:50:00Z' })),
      'Clock: Thursday 2026-10-22, 00:00 UTC',
    );
  });

  it('without a clock in the window: one now, with the date', () => {
    // A window that has just had a clock turned on, or a fork whose seed
    // copies its template's rows at the time of the copy: no boundary counts
    // as told, so it reads the time at its next write.
    assert.equal(
      text(plan({ now: '2026-10-21T10:47:00Z', newest: '2026-10-21T10:45:00Z' })),
      'Clock: Wednesday 2026-10-21, 10:47 UTC',
      'the newest row is past the boundary, so it reads the time it is written',
    );
    assert.equal(
      text(plan({ now: '2026-10-21T10:51:00Z', newest: '2026-10-21T10:45:00Z' })),
      'Clock: Wednesday 2026-10-21, 10:50 UTC',
    );
    assert.equal(text(plan({ now: '2026-10-21T10:51:00Z' })), 'Clock: Wednesday 2026-10-21, 10:50 UTC',
      'an empty window');
  });

  it('reads seconds when the precision is seconds', () => {
    const p = plan({
      now: '2026-10-21T10:50:31Z', newest: '2026-10-21T10:50:29Z', lastClock: '2026-10-21T10:50:00Z',
      config: { intervalSeconds: 30, precision: 'seconds' },
    });
    assert.equal(text(p), 'Clock: 10:50:30 UTC');
  });
});

// ---------------------------------------------------------------------------
// In the framework
// ---------------------------------------------------------------------------

class ToolModule implements Module {
  readonly name = 'tools';
  /** Runs inside the next tool call: the round's time passes here. */
  during: (() => void) | null = null;
  async start(ctx: ModuleContext) { ctx.registerSpeechHandler('*'); }
  async stop() {}
  async onProcess() { return {}; }
  async onAgentSpeech() {}
  getTools(): ToolDefinition[] {
    return [{ name: 'ping', description: 'explicit action', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    const during = this.during;
    this.during = null;
    during?.();
    return { success: true, data: { ok: true } };
  }
}

let seq = 0;
function event(text: string) {
  const n = ++seq;
  return {
    type: 'mcpl:push-event', serverId: 'notes', featureSet: 'notes',
    eventId: `ev-${n}`, content: [{ type: 'text', text }], timestamp: new Date().toISOString(),
    inferenceId: `inf-ev-${n}`, triggerInference: true,
  };
}
function silentTick() {
  const n = ++seq;
  return {
    type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat',
    eventId: `hb-${n}`, content: [], timestamp: new Date().toISOString(),
    origin: { source: 'heartbeat', reason: 'schedule', silent: true, scheduledAt: '2026-10-21 10:51:00 UTC' },
    inferenceId: `inf-hb-${n}`, triggerInference: true,
  };
}

type Row = { participant: string; content: ContentBlock[]; metadata?: Record<string, any>; timestamp: Date };

/** A membrane that answers a turn it has no response queued for with a
 *  plain reply, for a test where a second resident takes turns of its own. */
class AnsweringMembrane extends MockMembrane {
  override streamYielding(request: NormalizedRequest, options?: unknown) {
    if ((this as unknown as { responseIndex: number }).responseIndex >= this.responses.length) {
      this.pushResponse(createMockResponse([{ type: 'text', text: '(nothing to add)' }]));
    }
    return super.streamYielding(request, options);
  }
}

describe('clock rows in the framework', () => {
  const realNow = Date.now;
  let frozen = 0;
  /** Set the clock to read `iso`. It advances a millisecond per read, never
   *  with the wall clock, so the times a test asserts don't depend on how
   *  long the host takes to run it. */
  const setClock = (iso: string) => { frozen = at(iso); };
  let dirs: string[] = [];

  beforeEach(() => {
    frozen = realNow();
    Date.now = () => frozen++;
  });
  afterEach(() => {
    Date.now = realNow;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  async function make(
    agent: Partial<AgentConfig> = { clock: { intervalMinutes: 10 } },
    more: { agents?: Array<Partial<AgentConfig>>; framework?: Record<string, unknown>; storePath?: string; membrane?: MockMembrane } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'clock-rows-'));
    dirs.push(dir);
    const membrane = more.membrane ?? new MockMembrane();
    const mod = new ToolModule();
    const base = { model: 'test', systemPrompt: 'test', proseRouting: 'locus' as const, maxTokens: 4_000 };
    const framework = await AgentFramework.create({
      storePath: more.storePath ?? join(dir, 'store'), membrane: membrane.asMembrane(), timeZone: 'UTC',
      agents: [
        { name: 'assistant', ...base, ...agent },
        ...(more.agents ?? []).map((a) => ({ name: 'other', ...base, ...a })),
      ],
      modules: [mod],
      ...more.framework,
    } as never);
    (framework as any).channelRegistry = new Proxy({
      resolveLocus: () => 'world:commons', getDefaultPublishChannel: () => 'world:commons',
      routeSpeech: async () => ({ delivered: true, channelId: 'world:commons' }),
      startTyping: () => {}, stopTyping: () => {},
      getChannelTools: () => [], getDescriptor: () => undefined,
    }, { get: (t, p: string) => p in t ? (t as any)[p] : () => undefined });
    return { membrane, mod, framework, dir };
  }

  async function wake(x: { membrane: MockMembrane; framework: AgentFramework }, ev: unknown, ...responses: ContentBlock[][]) {
    for (const content of responses) {
      x.membrane.pushResponse(createMockResponse(content, content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'));
    }
    (x.framework as any).handleMcplPushEvent(ev);
    await x.framework.runUntilIdle();
  }

  const rows = (framework: AgentFramework): Row[] =>
    framework.getAgent('assistant')!.getContextManager().getAllMessages() as unknown as Row[];
  const textOf = (row: Row) => row.content.map((b) => (b as { text?: string }).text ?? '').join('');
  const isClock = (row: Row) => row.metadata?.kind === 'clock';
  const indexOfText = (all: Row[], needle: string) => all.findIndex((r) => !isClock(r) && textOf(r).includes(needle));
  const requestText = (request: NormalizedRequest) =>
    request.messages.map((m) => m.content.map((b) => (b as { text?: string }).text ?? '').join('')).join('\n');

  it('writes the latest boundary ahead of an event after an idle gap, and only that one', async () => {
    const x = await make();
    try {
      setClock('2026-10-21T10:45:10Z');
      await wake(x, event('first'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-21T11:23:10Z');
      await wake(x, event('second'), [{ type: 'text', text: 'ok again' }]);

      const all = rows(x.framework);
      const first = indexOfText(all, 'first');
      const second = indexOfText(all, 'second');
      assert.ok(first > 0 && second > first);
      assert.equal(textOf(all[first - 1]!), 'Clock: Wednesday 2026-10-21, 10:40 UTC', 'the window\'s first clock carries the date');
      const between = all.slice(first + 1, second).filter(isClock);
      assert.deepEqual(between.map(textOf), ['Clock: 11:20 UTC'], 'one clock for the gap: 10:50 to 11:20 coalesced');
      assert.ok(isClock(all[second - 1]!), 'it stands right before the event');
      assert.deepEqual(all[second - 1]!.metadata, {
        system: true, kind: 'clock', clock: { at: at('2026-10-21T11:20:00Z'), onBoundary: true, zone: 'UTC' },
      });
      assert.equal(all[second - 1]!.participant, 'user');
      assert.match(requestText(x.membrane.calls[1]!), /Clock: 11:20 UTC[\s\S]*second/, 'the turn\'s request holds it before the event');
    } finally { await x.framework.stop(); }
  });

  it('a binding agent\'s note at that boundary names the clock it injects, by the id it was stored under', async () => {
    const x = await make({ clock: { intervalMinutes: 10 }, thinkingBinding: { binds: true } } as Partial<AgentConfig>);
    x.membrane.supportsInjectedMessages = true; // as membrane's native path declares
    const notes: string[][] = [];
    const cm = x.framework.getAgent('assistant')!.getContextManager();
    cm.noteRequestSent = (rows) => { notes.push(rows.map((row) => typeof row === 'string' ? row : 'marker')); return true; };
    try {
      setClock('2026-10-21T10:41:10Z');
      await wake(x, event('warm up'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-21T10:48:10Z');
      x.mod.during = () => setClock('2026-10-21T10:52:10Z');
      await wake(
        x, event('go'),
        [{ type: 'tool_use', id: 't1', name: 'tools--ping', input: {} } as ContentBlock],
        [{ type: 'text', text: 'done' }],
      );
      const all = x.framework.getAgent('assistant')!.getContextManager().getAllMessages();
      const results = all.findIndex((r) => r.content.some((b) => b.type === 'tool_result'));
      const clock = all[results + 1]!;
      assert.ok(isClock(clock as unknown as Row), 'the clock follows the tool results');
      const boundary = notes.find((rows) => rows.includes(all[results]!.id));
      assert.ok(boundary, JSON.stringify(notes));
      assert.deepEqual(boundary!.slice(-2), [all[results]!.id, clock.id], 'the results, then the clock, each by its stored id');
    } finally { await x.framework.stop(); }
  });

  it('after a tool round that spans a boundary: the time it is written, after the results, in the live stream too', async () => {
    const x = await make();
    x.membrane.supportsInjectedMessages = true; // as membrane's native path declares
    try {
      setClock('2026-10-21T10:41:10Z');
      await wake(x, event('warm up'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-21T10:48:10Z');
      x.mod.during = () => setClock('2026-10-21T10:52:10Z');
      await wake(
        x, event('go'),
        [{ type: 'tool_use', id: 't1', name: 'tools--ping', input: {} } as ContentBlock],
        [{ type: 'text', text: 'done' }],
      );

      const all = rows(x.framework);
      const results = all.findIndex((r) => r.content.some((b) => b.type === 'tool_result'));
      assert.ok(results > 0);
      const clock = all[results + 1]!;
      assert.ok(isClock(clock), 'the clock follows the tool results');
      assert.equal(textOf(clock), 'Clock: 10:52 UTC', 'not 10:50: the results (after 10:50) come before it');
      assert.equal(clock.metadata!.clock.onBoundary, false);
      assert.ok(clock.metadata!.clock.at >= clock.timestamp.getTime() - 1_000);
      assert.ok(all[results]!.timestamp.getTime() <= clock.metadata!.clock.at, 'never earlier than the row before it');

      const injected = x.membrane.lastStream!.receivedToolResultOptions[0]?.injectedMessages ?? [];
      assert.deepEqual(injected, [{ participant: 'user', content: clock.content }],
        'the stream got exactly the stored clock, so the window matches the live request');
      assert.equal(all.slice(results + 2).filter(isClock).length, 0, 'no second clock for the same boundary');

      // The window now holds two clocks, 10:40 and 10:52. An event before
      // 11:00 takes none: the last clock is the newest one, 10:52.
      setClock('2026-10-21T10:57:10Z');
      await wake(x, event('before eleven'), [{ type: 'text', text: 'ok' }]);
      assert.equal(rows(x.framework).filter(isClock).length, 2, 'no clock: 10:50 was told by the 10:52 clock');
    } finally { await x.framework.stop(); }
  });

  it('a silent heartbeat tick starts with a current clock, outside its own rows', async () => {
    const x = await make();
    try {
      setClock('2026-10-21T10:45:10Z');
      await wake(x, event('hello'), [{ type: 'text', text: 'hi' }]);
      setClock('2026-10-21T10:51:10Z');
      await wake(x, silentTick(), [{ type: 'text', text: 'all quiet' }]);

      const all = rows(x.framework);
      const reply = indexOfText(all, 'all quiet');
      const clock = all.slice(0, reply).reverse().find(isClock)!;
      assert.equal(textOf(clock), 'Clock: 10:50 UTC');
      assert.equal(clock.metadata!.silentHeartbeat, undefined, 'the clock is not one of the tick\'s rows');
      assert.match(requestText(x.membrane.calls[1]!), /Clock: 10:50 UTC/, 'the tick\'s request reads it');
    } finally { await x.framework.stop(); }
  });

  it('shows the date again when the day changes', async () => {
    const x = await make();
    try {
      setClock('2026-10-21T23:55:10Z');
      await wake(x, event('late'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-22T00:01:10Z');
      await wake(x, event('early'), [{ type: 'text', text: 'ok' }]);
      const all = rows(x.framework);
      assert.equal(textOf(all[indexOfText(all, 'early') - 1]!), 'Clock: Thursday 2026-10-22, 00:00 UTC');
    } finally { await x.framework.stop(); }
  });

  it('an agent without a clock gets no clock rows', async () => {
    const x = await make({});
    try {
      setClock('2026-10-21T10:45:10Z');
      await wake(x, event('first'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-21T11:23:10Z');
      x.mod.during = () => setClock('2026-10-21T11:42:10Z');
      await wake(
        x, event('second'),
        [{ type: 'tool_use', id: 't1', name: 'tools--ping', input: {} } as ContentBlock],
        [{ type: 'text', text: 'done' }],
      );
      assert.equal(rows(x.framework).filter(isClock).length, 0);
      const boundaries = x.membrane.lastStream!.receivedToolResultOptions;
      assert.equal(boundaries.length, 1, 'the tool boundary ran');
      assert.deepEqual(boundaries[0]?.injectedMessages ?? [], [], 'and injected nothing');
    } finally { await x.framework.stop(); }
  });

  const ping = { type: 'tool_use', id: 't1', name: 'tools--ping', input: {} } as ContentBlock;

  it('places boundaries in the framework\'s time zone', async () => {
    const x = await make({ clock: { intervalMinutes: 60 } }, { framework: { timeZone: 'Asia/Kathmandu' } });
    try {
      setClock('2026-10-21T10:20:10Z'); // 16:05 in Kathmandu (UTC+05:45)
      await wake(x, event('hello'), [{ type: 'text', text: 'ok' }]);
      const all = rows(x.framework);
      assert.equal(textOf(all[indexOfText(all, 'hello') - 1]!), 'Clock: Wednesday 2026-10-21, 16:00 Asia/Kathmandu (UTC+05:45)');
    } finally { await x.framework.stop(); }
  });

  it('finds the window\'s last clock however far back it is, after a restart too', async () => {
    const x = await make();
    let stopped = false;
    try {
      setClock('2026-10-21T10:41:10Z');
      await wake(x, event('warm'), [{ type: 'text', text: 'ok' }]);
      // 600 rows with no clock among them, across the 10:50 boundary: a
      // long turn's rows, say, on a stream that took no mid-turn clock.
      const cm = x.framework.getAgent('assistant')!.getContextManager();
      setClock('2026-10-21T10:48:00Z');
      for (let i = 0; i < 600; i++) {
        if (i === 300) setClock('2026-10-21T10:52:00Z');
        cm.addMessage(i % 2 ? 'assistant' : 'user', [{ type: 'text', text: `row ${i}` }]);
      }
      await x.framework.stop();
      stopped = true;
    } finally { if (!stopped) await x.framework.stop(); }

    const y = await make(undefined, { storePath: join(x.dir, 'store') });
    try {
      setClock('2026-10-21T10:55:10Z');
      await wake(y, event('after the restart'), [{ type: 'text', text: 'ok' }]);
      const all = rows(y.framework);
      const clock = all[indexOfText(all, 'after the restart') - 1]!;
      assert.ok(isClock(clock), 'the 10:50 boundary passed since the last clock, 600 rows back');
      assert.equal(textOf(clock), 'Clock: 10:55 UTC', 'the time it is written, since rows after 10:50 come before it');
    } finally { await y.framework.stop(); }
  });

  it('a conversation fork reads the time in its first request, not only its template\'s clocks', async () => {
    const x = await make(undefined, { framework: { conversations: { templateAgent: 'assistant' } } });
    try {
      setClock('2026-10-21T10:41:10Z');
      await wake(x, event('warm'), [{ type: 'text', text: 'ok' }]);
      // 86 minutes later, a DM spawns the channel's fork, seeded with copies
      // of the template's rows, the 10:40 clock among them.
      setClock('2026-10-21T12:07:10Z');
      x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi alice' }]));
      const before = x.membrane.calls.length;
      x.framework.pushEvent({
        type: 'mcpl:channel-incoming', serverId: 'srv', channelId: 'slack:D1', messageId: 'm-1',
        author: { id: 'U1', name: 'alice' }, content: [{ type: 'text', text: 'hello' }], timestamp: new Date(Date.now()).toISOString(),
        metadata: { mentioned: false, channel_type: 'im' }, triggerInference: true,
      } as never);
      await x.framework.runUntilIdle();
      assert.ok(x.framework.getAgent(forkAgentName('conversation', 'srv', 'slack:D1', 1)), 'the fork was spawned');
      const request = requestText(x.membrane.calls[before]!);
      assert.match(request, /Clock: Wednesday 2026-10-21, 10:40 UTC/, 'its seed carries the template\'s clock');
      assert.match(request, /Clock: Wednesday 2026-10-21, 12:07 UTC[\s\S]*hello/, 'and a clock of its own ahead of the message');
    } finally { await x.framework.stop(); }
  });

  it('a mid-turn clock and a message after it each go in as their own render gives them', async () => {
    const x = await make();
    x.membrane.supportsInjectedMessages = true;
    try {
      setClock('2026-10-21T10:41:10Z');
      await wake(x, event('warm up'), [{ type: 'text', text: 'ok' }]);
      const cm = x.framework.getAgent('assistant')!.getContextManager() as any;
      const asked: number[] = [];
      // A stand-in that marks each id's answer with its position in the batch.
      cm.renderAsNewest = (ids: readonly string[]) => { asked.push(ids.length); return ids.map((_, i) => [{ type: 'text', text: `RENDERED${i}` }]); };
      setClock('2026-10-21T10:48:10Z');
      x.mod.during = () => {
        setClock('2026-10-21T10:52:10Z');
        // Queued for the agent to hear, synchronously, with no wake of its own.
        (x.framework as any).handleMcplPushEvent({ ...event('MIDTURN'), triggerInference: false });
      };
      // The stream that runs the tool round, kept before the message's own
      // wake starts another and takes lastStream.
      let boundary: typeof x.membrane.lastStream = null;
      const streamYielding = x.membrane.streamYielding.bind(x.membrane);
      x.membrane.streamYielding = (...args: Parameters<typeof streamYielding>) => {
        const st = streamYielding(...args);
        boundary ??= x.membrane.lastStream;
        return st;
      };
      await wake(x, event('go'), [ping], [{ type: 'text', text: 'done' }]);
      assert.deepEqual(asked, [2], 'the premise: the boundary rendered a clock and a message together');
      const injected = (boundary!.receivedToolResultOptions[0]?.injectedMessages ?? []) as Array<{ content: unknown }>;
      assert.deepEqual(injected.map((m) => m.content), [[{ type: 'text', text: 'RENDERED0' }], [{ type: 'text', text: 'RENDERED1' }]]);
    } finally { await x.framework.stop(); }
  });

  it('a mid-turn clock the render gives null goes in as stored, as the next compile sends it from before its window', async () => {
    const x = await make();
    x.membrane.supportsInjectedMessages = true;
    try {
      setClock('2026-10-21T10:41:10Z');
      await wake(x, event('warm up'), [{ type: 'text', text: 'ok' }]);
      const cm = x.framework.getAgent('assistant')!.getContextManager() as any;
      let rendered = 0;
      cm.renderAsNewest = (ids: readonly string[]) => { rendered++; return ids.map(() => null); };
      setClock('2026-10-21T10:48:10Z');
      x.mod.during = () => setClock('2026-10-21T10:52:10Z');
      await wake(x, event('go'), [ping], [{ type: 'text', text: 'done' }]);
      assert.equal(rendered, 1, 'the premise: the boundary rendered the clock');
      const all = rows(x.framework);
      const clock = all[all.findIndex((r) => r.content.some((b) => b.type === 'tool_result')) + 1]!;
      assert.ok(isClock(clock), 'the premise: a clock follows the tool results');
      assert.deepEqual(x.membrane.lastStream!.receivedToolResultOptions[0]?.injectedMessages,
        [{ participant: 'user', content: clock.content }], 'the stream got the stored clock');
    } finally { await x.framework.stop(); }
  });

  it('on a stream that can\'t carry injected messages: no mid-turn clock, and the next event takes it', async () => {
    const x = await make();
    x.membrane.supportsInjectedMessages = false;
    try {
      setClock('2026-10-21T10:41:10Z');
      await wake(x, event('warm up'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-21T10:48:10Z');
      x.mod.during = () => setClock('2026-10-21T10:52:10Z');
      await wake(x, event('go'), [ping], [{ type: 'text', text: 'done' }]);
      assert.equal(x.membrane.lastStream!.receivedToolResultOptions.length, 1, 'the tool boundary ran');
      const all = rows(x.framework);
      const results = all.findIndex((r) => r.content.some((b) => b.type === 'tool_result'));
      assert.equal(all.slice(results).filter(isClock).length, 0, 'no clock stored mid-turn: the stream couldn\'t carry it');
      setClock('2026-10-21T10:55:10Z');
      await wake(x, event('next'), [{ type: 'text', text: 'ok' }]);
      const after = rows(x.framework);
      assert.equal(textOf(after[indexOfText(after, 'next') - 1]!), 'Clock: 10:55 UTC');
    } finally { await x.framework.stop(); }
  });

  it('after a direct-API tool round whose result ends the turn: the clock follows the results', async () => {
    const x = await make();
    try {
      setClock('2026-10-21T10:41:10Z');
      await wake(x, event('warm up'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-21T10:52:10Z');
      const agent = x.framework.getAgent('assistant')!;
      const response = createMockResponse([{ type: 'tool_use', id: 'direct-1', name: 'tools--ping', input: {} }] as ContentBlock[], 'tool_use');
      (x.membrane as unknown as { stream: () => Promise<typeof response> }).stream = async () => response;
      agent.getContextManager().addMessage('user', [{ type: 'text', text: 'take the direct path' }]);
      await agent.runInference(x.framework.getAllTools());
      assert.equal((agent.state as { stream?: unknown }).stream, undefined, 'the premise: no yielding stream');
      await (x.framework as unknown as { handleProcessEvent(e: unknown): Promise<void> }).handleProcessEvent({
        type: 'tool-result', source: 'tools', moduleName: 'tools', agentName: 'assistant', callId: 'direct-1',
        result: { success: true, data: { ok: true }, endTurn: true },
      });
      const all = rows(x.framework);
      const results = all.findIndex((r) => r.content.some((b) => b.type === 'tool_result'));
      assert.ok(results > 0, "the round's results are stored");
      assert.deepEqual(all.slice(results + 1).map((r) => (isClock(r) ? textOf(r) : r.participant)), ['Clock: 10:52 UTC'],
        'the clock follows the tool results, and nothing else does');
    } finally { await x.framework.stop(); }
  });

  it('writes no clock before a tool\'s results or the agent\'s own row, through the store path', async () => {
    const x = await make();
    try {
      setClock('2026-10-21T10:41:10Z');
      await wake(x, event('warm'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-21T10:55:10Z');
      const add = (participant: string, content: unknown[]) => (x.framework as any).addMessage(participant, content, {});
      add('user', [{ type: 'tool_result', toolUseId: 'toolu_late', content: 'late result' }]);
      add('assistant', [{ type: 'text', text: 'own words' }]);
      assert.equal(rows(x.framework).filter(isClock).length, 1, 'neither takes one, though 10:50 has passed');
      add('user', [{ type: 'text', text: 'a note' }]);
      const all = rows(x.framework);
      assert.ok(isClock(all[indexOfText(all, 'a note') - 1]!), 'a plain arrival does');
    } finally { await x.framework.stop(); }
  });

  it('writes no clock while the host is quiesced, not even at a draining turn\'s tool boundary', async () => {
    const x = await make();
    try {
      setClock('2026-10-21T10:41:10Z');
      await wake(x, event('warm'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-21T10:48:10Z');
      let quiescing: Promise<unknown> | undefined;
      x.mod.during = () => {
        setClock('2026-10-21T10:52:10Z');
        quiescing = x.framework.quiesce({ reason: 'surgery' });
      };
      await wake(x, event('go'), [ping], [{ type: 'text', text: 'done' }]);
      await quiescing;
      assert.equal(x.membrane.lastStream!.receivedToolResultOptions.length, 1, 'the tool boundary ran');
      assert.equal(rows(x.framework).filter(isClock).length, 1, 'the first clock only: none while quiesced');
      setClock('2026-10-21T10:56:10Z');
      await x.framework.resume();
      await wake(x, event('after'), [{ type: 'text', text: 'ok' }]);
      const all = rows(x.framework);
      assert.equal(textOf(all[indexOfText(all, 'after') - 1]!), 'Clock: 10:56 UTC', 'once it resumes');
    } finally { await x.framework.stop(); }
  });

  it('writes no clock into the residents\' shared slot while another resident\'s turn is alive', async () => {
    const x = await make(undefined, { agents: [{ name: 'other', clock: { intervalMinutes: 10 } }], membrane: new AnsweringMembrane() });
    const writeFor = (name: string, text: string) =>
      (x.framework as any).addMessage('user', [{ type: 'text', text }], {}, { forAgent: name });
    try {
      setClock('2026-10-21T10:41:10Z');
      await wake(x, event('warm'), [{ type: 'text', text: 'ok' }]);
      setClock('2026-10-21T11:05:10Z');
      x.mod.during = () => {
        setClock('2026-10-21T11:16:10Z');
        writeFor('other', 'for other, mid-turn');
      };
      await wake(x, event('go'), [ping], [{ type: 'text', text: 'done' }]);
      setClock('2026-10-21T11:31:10Z');
      writeFor('other', 'for other, after');
      await x.framework.runUntilIdle();
      const all = rows(x.framework);
      assert.ok(!isClock(all[indexOfText(all, 'for other, mid-turn') - 1]!),
        'none while the assistant\'s turn is alive, though 11:10 had passed: it would sit inside that turn');
      assert.equal(textOf(all[indexOfText(all, 'for other, after') - 1]!), 'Clock: 11:30 UTC', 'one once it has ended');
    } finally { await x.framework.stop(); }
  });

  it('the subconscious takes no clock of its own', async () => {
    const x = await make(undefined, { framework: { subconscious: { enabled: true, systemPrompt: 'notice' } } });
    try {
      assert.ok(x.framework.getAgent('assistant')!.clock, 'the resident has one');
      assert.equal(x.framework.getAgent('Subconscious')!.clock, undefined, 'its merged view carries the resident\'s');
    } finally { await x.framework.stop(); }
  });

  it('a clock whose write throws after it landed is injected all the same; one that never landed holds nothing up', async () => {
    const x = await make();
    try {
      setClock('2026-10-21T10:41:10Z');
      await wake(x, event('warm up'), [{ type: 'text', text: 'ok' }]);
      const cm = x.framework.getAgent('assistant')!.getContextManager() as any;
      const addMessage = cm.addMessage.bind(cm);
      let thrown = 0;
      cm.addMessage = (participant: string, content: unknown, metadata?: { kind?: string }, ...rest: unknown[]) => {
        const id = addMessage(participant, content, metadata, ...rest);
        if (metadata?.kind === 'clock') { thrown++; throw new Error('its propagation failed after the append'); }
        return id;
      };
      setClock('2026-10-21T10:48:10Z');
      x.mod.during = () => setClock('2026-10-21T10:52:10Z');
      await wake(x, event('go'), [ping], [{ type: 'text', text: 'done' }]);
      assert.equal(thrown, 1, 'the clock\'s write threw');
      const clocks = rows(x.framework).filter(isClock);
      assert.equal(clocks.length, 2, 'it landed, once');
      assert.deepEqual(x.membrane.lastStream!.receivedToolResultOptions[0]?.injectedMessages,
        [{ participant: 'user', content: clocks[1]!.content }], 'and the stream got it, so the window matches the live request');

      let refused = 0;
      cm.addMessage = (participant: string, content: unknown, metadata?: { kind?: string }, ...rest: unknown[]) => {
        if (metadata?.kind === 'clock') { refused++; throw new Error('refused before the append'); }
        return addMessage(participant, content, metadata, ...rest);
      };
      // A tool round across 11:00 whose clock is refused: nothing is stored
      // or injected, and the round goes on.
      setClock('2026-10-21T10:58:10Z');
      x.mod.during = () => setClock('2026-10-21T11:02:10Z');
      await wake(x, event('still heard'), [{ ...ping, id: 't2' } as ContentBlock], [{ type: 'text', text: 'got it' }]);
      assert.ok(refused >= 1, 'a clock was due and its write was refused');
      assert.deepEqual(x.membrane.lastStream!.receivedToolResultOptions.length, 1, 'the tool boundary ran');
      assert.deepEqual(x.membrane.lastStream!.receivedToolResultOptions[0]?.injectedMessages ?? [], [], 'and injected no clock');
      const all = rows(x.framework);
      assert.ok(indexOfText(all, 'still heard') > 0 && indexOfText(all, 'got it') > 0, 'the event, the round and its reply landed');
      assert.equal(all.filter(isClock).length, 2, 'with no clock');
    } finally { await x.framework.stop(); }
  });

  it('refuses a clock setting it cannot read when the framework is created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clock-rows-'));
    dirs.push(dir);
    await assert.rejects(
      AgentFramework.create({
        storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test', clock: { intervalSeconds: 90, precision: 'minutes' } }],
        modules: [],
      }),
      /Agent "assistant" clock: an interval of 90 seconds isn't whole minutes/,
    );
  });
});

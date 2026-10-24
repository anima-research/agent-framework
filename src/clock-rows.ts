/**
 * Clock rows: a time marker an agent's window takes when an interval
 * boundary has passed since the last one it holds.
 *
 * The model is a tick event at every boundary of the agent's local wall
 * clock (every 10 minutes, say, from local midnight). The ticks aren't
 * written as they fire. One is written when the window next takes something
 * (an incoming event, a tool round's results, the start of a turn), and only
 * the latest of the ticks that fired meanwhile: nothing was written between
 * them, and a clock wakes no one, so the window reads exactly as it would
 * had every tick been written and the earlier ones coalesced away.
 *
 * A clock never lies about order. One that lands where its tick would have
 * been (the row before it is no newer than the boundary) reads the
 * boundary's time, which is in the past by the time it is written. One that
 * can't (the boundary passed while the agent was mid-reply or a tool ran:
 * a tool's results must follow its call directly, so nothing can be written
 * between them) reads the time it is written instead.
 *
 * Everything the next clock needs is read back from the window: the last
 * clock row's time, wherever it is, and the newest row's. A window that
 * holds no clock row takes one the next time it would take a clock (an
 * incoming event, a turn's start, a tool boundary), so a window that has
 * just had a clock turned on, or a fork seeded with copies of its
 * template's rows (which carry none of their metadata), reads the time
 * then. A restart, a rollback or a second resident sharing the window
 * leaves nothing stale to reconcile.
 */

import type { ContentBlock } from '@animalabs/membrane';
import { resolveTimeZone } from './timezone.js';

/** `AgentConfig.clock`: when the agent's window takes clock rows. */
export interface ClockConfig {
  /** Minutes between boundaries. Give this or `intervalSeconds`. */
  intervalMinutes?: number;
  /** Seconds between boundaries, for clocks finer than a minute. */
  intervalSeconds?: number;
  /**
   * How a clock reads: `'minutes'` (`10:50`) or `'seconds'` (`10:50:30`).
   * Defaults to minutes for an interval of whole minutes, else seconds.
   */
  precision?: 'minutes' | 'seconds';
}

export interface ResolvedClockConfig {
  intervalSeconds: number;
  precision: 'minutes' | 'seconds';
}

/** `metadata.kind` of a clock row. */
export const CLOCK_ROW_KIND = 'clock';

/** `metadata.clock` of a clock row. */
export interface ClockStamp {
  /** The instant the row reads, epoch ms. */
  at: number;
  /** Whether that instant is the boundary itself (else, when it was written). */
  onBoundary: boolean;
  /** The IANA zone it reads in. */
  zone: string;
}

const DAY_SECONDS = 86_400;

/**
 * Validate `AgentConfig.clock`. Undefined when the agent has no clock; throws
 * on a setting that can't be read as one, naming the agent.
 */
export function resolveClockConfig(agentName: string, config: ClockConfig | undefined): ResolvedClockConfig | undefined {
  if (config === undefined) return undefined;
  const at = `Agent "${agentName}" clock`;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${at} must be an object such as { intervalMinutes: 10 }, or left out for no clock rows of its own`);
  }
  const { intervalMinutes, intervalSeconds, precision } = config;
  if ((intervalMinutes === undefined) === (intervalSeconds === undefined)) {
    throw new Error(`${at} takes exactly one of intervalMinutes and intervalSeconds`);
  }
  const given = intervalMinutes !== undefined ? intervalMinutes : intervalSeconds;
  if (typeof given !== 'number' || !Number.isInteger(given) || given <= 0) {
    throw new Error(
      `${at}.${intervalMinutes !== undefined ? 'intervalMinutes' : 'intervalSeconds'} must be a positive whole number`,
    );
  }
  const seconds = intervalMinutes !== undefined ? given * 60 : given;
  if (seconds > DAY_SECONDS) {
    throw new Error(`${at} interval is at most a day (1440 minutes); boundaries count from local midnight`);
  }
  if (precision !== undefined && precision !== 'minutes' && precision !== 'seconds') {
    throw new Error(`${at}.precision must be 'minutes' or 'seconds'`);
  }
  const resolved = precision ?? (seconds % 60 === 0 ? 'minutes' : 'seconds');
  if (resolved === 'minutes' && seconds % 60 !== 0) {
    throw new Error(`${at}: an interval of ${seconds} seconds isn't whole minutes, so its clocks need precision 'seconds'`);
  }
  return { intervalSeconds: seconds, precision: resolved };
}

// ---------------------------------------------------------------------------
// Wall-clock arithmetic in a zone
// ---------------------------------------------------------------------------

interface WallFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Offset from UTC at this instant, in minutes. */
  offsetMinutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

function wallFields(at: number, zone: string): WallFields {
  const parts = formatterFor(zone).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);
  const fields = {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
  const shownAsUtc = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
  const offsetMinutes = Math.round((shownAsUtc - Math.floor(at / 1000) * 1000) / 60_000);
  return { ...fields, offsetMinutes };
}

/**
 * The latest boundary at or before `now`: an instant at which the zone's
 * wall clock read a whole multiple of the interval since local midnight. A
 * boundary whose wall time a DST change skips doesn't occur; one it repeats
 * occurs twice.
 *
 * While the zone's offset stays the same, its wall clock runs with real
 * time, so the latest boundary is `now` less how far the wall clock has run
 * past its last multiple of the interval. Where that instant has another
 * offset, the offset changed in between and no boundary falls between the
 * change and `now`: the walk goes on from just before the change. The change
 * is found by searching between the two instants, whatever their offsets
 * are. The same offset at both is taken to mean no change between them: in
 * the tz data, no zone changes its offset twice within a day, the longest
 * interval, from 2024 through 2040. Throws if the walk passes 24 changes,
 * which no real zone reaches, rather than return an instant that isn't a
 * boundary.
 */
export function latestBoundary(now: number, intervalSeconds: number, zone: string): number {
  let at = now;
  // A pass that doesn't return steps back past an offset change, and a day
  // of a real zone holds at most two of them; running out of passes is a
  // defect, and it throws rather than return an instant that isn't a boundary.
  for (let pass = 0; pass < 24; pass++) {
    const f = wallFields(at, zone);
    const secondOfDay = f.hour * 3600 + f.minute * 60 + f.second;
    const subSecond = at - Math.floor(at / 1000) * 1000;
    const candidate = at - (secondOfDay % intervalSeconds) * 1000 - subSecond;
    if (wallFields(candidate, zone).offsetMinutes === f.offsetMinutes) return candidate;
    at = offsetTakenAt(candidate, at, f.offsetMinutes, zone) - 1;
  }
  throw new Error(`no clock boundary found within 24 offset changes of ${new Date(now).toISOString()} in ${zone}`);
}

/**
 * The instant in (`from`, `to`] at which the zone took `offset`, given that
 * `to` reads at that offset and `from` doesn't, to the millisecond.
 */
function offsetTakenAt(from: number, to: number, offset: number, zone: string): number {
  let before = from;
  let after = to;
  while (after - before > 1) {
    const mid = Math.floor((before + after) / 2);
    if (wallFields(mid, zone).offsetMinutes === offset) after = mid;
    else before = mid;
  }
  return after;
}

// ---------------------------------------------------------------------------
// What a clock reads
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n: number): string => String(n).padStart(2, '0');

function localDate(at: number, zone: string): string {
  const f = wallFields(at, zone);
  return `${f.year}-${pad(f.month)}-${pad(f.day)}`;
}

function isUtcZone(zone: string): boolean {
  return /^(Etc\/)?(UTC|UCT|Zulu|Universal|GMT|Greenwich)$/.test(zone) || zone === 'Etc/GMT0' || zone === 'GMT0';
}

/**
 * A clock row's text: `Clock: 10:50 Europe/Berlin (UTC+02:00)`, with the
 * weekday and date ahead of the time when `withDate`
 * (`Clock: Thursday 2026-10-22, 00:00 Europe/Berlin (UTC+02:00)`).
 */
export function formatClockText(
  at: number,
  zone: string,
  precision: 'minutes' | 'seconds',
  withDate: boolean,
): string {
  const f = wallFields(at, zone);
  const time = precision === 'seconds'
    ? `${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}`
    : `${pad(f.hour)}:${pad(f.minute)}`;
  const weekday = WEEKDAYS[new Date(Date.UTC(f.year, f.month - 1, f.day)).getUTCDay()];
  const date = withDate ? `${weekday} ${f.year}-${pad(f.month)}-${pad(f.day)}, ` : '';
  const sign = f.offsetMinutes < 0 ? '-' : '+';
  const offset = Math.abs(f.offsetMinutes);
  const where = isUtcZone(zone) && f.offsetMinutes === 0
    ? 'UTC'
    : `${zone} (UTC${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)})`;
  return `Clock: ${date}${time} ${where}`;
}

/** A clock row to store. */
export interface PlannedClock {
  content: ContentBlock[];
  stamp: ClockStamp;
}

/**
 * The clock row the window takes next, or null when no boundary has passed
 * since the last clock it holds. The framework asks before an incoming
 * event, at a turn's start and at a tool boundary (storeDueClock).
 *
 * - `newestRowAt`: the newest row's time, which the clock goes after.
 * - `lastClockAt`: the time the window's last clock row reads, when it holds
 *   one. Without one, no boundary counts as told: the window takes a clock
 *   now, and it carries the date.
 */
export function planClock(args: {
  now: number;
  newestRowAt: number | undefined;
  lastClockAt: number | undefined;
  config: ResolvedClockConfig;
  zone: string;
}): PlannedClock | null {
  const { now, newestRowAt, lastClockAt, config } = args;
  const zone = resolveTimeZone(args.zone);
  const boundary = latestBoundary(now, config.intervalSeconds, zone);
  const told = lastClockAt !== undefined ? latestBoundary(lastClockAt, config.intervalSeconds, zone) : -Infinity;
  if (boundary <= told) return null;
  // The boundary's own time only where its tick would have been: no row
  // after the boundary comes before the clock. Otherwise the time it is
  // written, and never earlier than the row it follows.
  const onBoundary = newestRowAt === undefined || newestRowAt <= boundary;
  const at = onBoundary ? boundary : Math.max(now, newestRowAt);
  const withDate = lastClockAt === undefined || localDate(lastClockAt, zone) !== localDate(at, zone);
  return {
    content: [{ type: 'text', text: formatClockText(at, zone, config.precision, withDate) }],
    stamp: { at, onBoundary, zone },
  };
}

/** The clock stamp a stored row's metadata carries, if it is a clock row. */
export function clockStampOf(metadata: unknown): ClockStamp | undefined {
  const m = metadata as { kind?: unknown; clock?: { at?: unknown } } | undefined;
  if (m?.kind !== CLOCK_ROW_KIND || typeof m.clock?.at !== 'number') return undefined;
  return m.clock as ClockStamp;
}

/** Whether a row can have a clock written before it: not the agent's own
 *  (an assistant turn), no tool blocks (a tool's results follow its call
 *  directly), and not itself a clock. */
export function takesClockBefore(
  participant: string,
  content: readonly ContentBlock[],
  metadata: unknown,
  agentName: string,
): boolean {
  return participant !== agentName
    && !content.some((b) => b.type === 'tool_use' || b.type === 'tool_result')
    && clockStampOf(metadata) === undefined;
}

/**
 * Agent-visible wall-clock formatting.
 *
 * Persistence and protocol timestamps should remain epoch milliseconds or UTC
 * ISO strings.  These helpers are for presentation boundaries where a
 * timestamp is rendered into an agent's context or a tool result, and the
 * zone resolveTimeZone gives also places clock rows' boundaries
 * (clock-rows.ts).
 */

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(configured?: string): string {
  const candidate = configured?.trim()
    || process.env.AGENT_TIMEZONE?.trim()
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC';
  if (!isValidTimeZone(candidate)) {
    throw new Error(`Invalid IANA time zone: ${JSON.stringify(candidate)}`);
  }
  return candidate;
}

type ZonedParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** RFC3339-style local time with an explicit numeric offset and IANA zone. */
export function formatZonedDateTime(value: Date | number | string, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${String(value)}`);
  const zone = resolveTimeZone(timeZone);
  const p = zonedParts(date, zone);

  // Reinterpret the displayed wall-clock components as UTC to recover the
  // offset that applied at this exact instant (including DST transitions).
  const displayedAsUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second),
  );
  const instantAtWholeSecond = Math.floor(date.getTime() / 1000) * 1000;
  const offsetMinutes = Math.round((displayedAsUtc - instantAtWholeSecond) / 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, '0')}:${String(absoluteOffset % 60).padStart(2, '0')}`;
  const millis = String(date.getUTCMilliseconds()).padStart(3, '0');

  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${millis}${offset} [${zone}]`;
}

/** Compact wall-clock time for provenance headers. */
export function formatZonedTime(value: Date | number | string, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${String(value)}`);
  const p = zonedParts(date, resolveTimeZone(timeZone));
  return `${p.hour}:${p.minute}`;
}

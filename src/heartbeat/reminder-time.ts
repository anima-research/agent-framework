/**
 * Reading a reminder's `atIso` in the agent's time zone, ported from heartbeat-mcpl
 * (src/reminder-time.ts) when the heartbeat moved into the framework: a time
 * without an offset is read in the zone, and a wall time a clock change skips
 * or repeats is refused, naming the offsets that would say which instant.
 */
const DAY_MS = 86_400_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

export const FIRST_REMINDER_TIME = '-271821-04-20T00:00:00Z';
export const LAST_REMINDER_TIME = '+275760-09-13T00:00:00Z';

export function canHoldTime(ms: number): boolean {
  return Math.abs(ms) <= MAX_DATE_MS;
}

function isCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** ISO 8601 reads 24:00 as the end of the day. */
function isClockTime(hour: number, minute: number, second: number, fraction: number): boolean {
  if (hour === 24) return minute === 0 && second === 0 && fraction === 0;
  return hour <= 23 && minute <= 59 && second <= 59;
}

/** Intl names offsets with a GMT prefix, with seconds for the historical ones, and ICU 76,
 *  which Node 22.12.0 has, names the zero offset GMT alone. */
function offsetMilliseconds(offset: string): number | null {
  if (/^(Z|GMT)$/i.test(offset)) return 0;
  const match = /^(?:GMT)?([+-])(\d{2})(?:(:?)(\d{2})(?:\3(\d{2}))?)?$/.exec(offset);
  if (!match || +match[2] > 23 || +(match[4] ?? 0) > 59 || +(match[5] ?? 0) > 59) return null;
  return (match[1] === '-' ? -1 : 1)
    * (+match[2] * 3600 + +(match[4] ?? 0) * 60 + +(match[5] ?? 0)) * 1000;
}

export function parseReminderTime(atIso: string, timeZone: string): number {
  const shown = JSON.stringify(atIso);
  const parts = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-][\d:]+)?)?$/.exec(atIso);
  // ECMAScript's date-time format refuses -000000 for year zero.
  if (!parts || parts[1] === '-000000') {
    throw new Error(`"atIso" ${shown} isn't a time this tool reads. Give a date and time like "2030-07-15T09:00", read in `
      + `${timeZone}, or end it with an offset, like "2030-07-15T09:00Z" or "2030-07-15T09:00+01:00". A date alone is `
      + `midnight in ${timeZone}. For a delay from now, give inSeconds, inMinutes or inHours instead.`);
  }
  const givenOffset = parts[8] ? offsetMilliseconds(parts[8]) : null;
  if (parts[8] && givenOffset === null) {
    throw new Error(`"atIso" ${shown} ends in ${JSON.stringify(parts[8])}, which isn't a UTC offset. `
      + 'End it with Z for UTC, or an offset like +05:30, +0530 or +05.');
  }
  const calendarDate = `${parts[1]}-${parts[2]}-${parts[3]}`;
  const readIn = parts[8] ? '' : `, read in ${timeZone}`;
  const example = (time: string) => `"${time}${parts[8] ?? ''}"${readIn}`;
  if (!isCalendarDay(+parts[1], +parts[2], +parts[3])) {
    throw new Error(`"atIso" ${shown} names a day the calendar doesn't have, ${calendarDate}. Give a real date, like ${example('2030-03-01T09:00')}.`);
  }
  // A Date keeps milliseconds, so digits past them don't count.
  if (!isClockTime(+(parts[4] ?? 0), +(parts[5] ?? 0), +(parts[6] ?? 0), +(parts[7] ?? '0').slice(0, 3))) {
    throw new Error(`"atIso" ${shown} has a time no clock shows: hours run 00 to 23 and minutes and seconds 00 to 59, `
      + `and 24:00, the end of the day, takes no minutes, seconds or milliseconds after it. Give one like ${example(`${calendarDate}T09:00`)}.`);
  }
  const outOfRange = new Error(`"atIso" ${shown}${readIn ? `${readIn},` : ''} is outside the times a reminder can hold, `
    + `${FIRST_REMINDER_TIME} to ${LAST_REMINDER_TIME}. Give a time inside that range.`);
  // Date.parse reads 24:00 as the start of the next day.
  const wall = Date.parse(`${calendarDate}T${parts[4] ?? '00'}:${parts[5] ?? '00'}:${parts[6] ?? '00'}.${(parts[7] ?? '0').slice(0, 3).padEnd(3, '0')}Z`);
  if (!Number.isFinite(Date.parse(`${calendarDate}T00:00:00Z`)) || !Number.isFinite(wall)) throw outOfRange;

  if (givenOffset !== null) {
    const instant = wall - givenOffset;
    if (Math.abs(instant) > MAX_DATE_MS) throw outOfRange;
    return instant;
  }

  const asTime = parts[4] === undefined ? `${calendarDate}T00:00` : atIso;
  const withOffsets = (labels: string[]) => labels.map((label) => JSON.stringify(`${asTime}${label}`)).join(' or ');
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
  const offsetAt = (ms: number) => {
    const name = formatter.formatToParts(new Date(ms)).find((part) => part.type === 'timeZoneName')?.value;
    const offset = name ? offsetMilliseconds(name) : null;
    if (!name || offset === null) {
      throw new Error(`"atIso" ${shown} has no offset, and the zone it would be read in, ${timeZone}, can't be read here. `
        + `End it with an offset, like ${withOffsets(['Z', '+01:00'])}, or give a delay from now in inSeconds, inMinutes or inHours.`);
    }
    return { ms: offset, label: name === 'GMT' ? '+00:00' : name.slice(3) };
  };

  // Around a clock change a wall time has no instant (a gap) or two (a fold).
  const offsets = new Map<number, string>();
  for (const delta of [-DAY_MS, DAY_MS]) {
    const sample = Math.abs(wall + delta) <= MAX_DATE_MS ? wall + delta : wall;
    const offset = offsetAt(sample);
    offsets.set(offset.ms, offset.label);
  }
  const inRange = [...offsets].filter(([offset]) => Math.abs(wall - offset) <= MAX_DATE_MS);
  if (inRange.length === 0) throw outOfRange;
  const candidates = inRange.filter(([offset]) => offsetAt(wall - offset).ms === offset);
  if (candidates.length === 1) return wall - candidates[0][0];
  const read = parts[4] === undefined ? `${shown} is read as ${asTime}, which` : shown;
  if (candidates.length > 1) {
    throw new Error(`"atIso" ${read} happens twice in ${timeZone}, where the clocks go back over it. `
      + `End it with the offset you mean: ${withOffsets(candidates.map(([, label]) => label))}.`);
  }
  throw new Error(`"atIso" ${read} doesn't exist in ${timeZone}, where the clocks skip over it. Give a time that exists `
    + `there, or end it with an offset to say which instant you mean, like ${withOffsets([...offsets.values()])}.`);
}

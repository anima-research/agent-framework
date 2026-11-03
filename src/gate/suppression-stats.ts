/**
 * What the agent's suppress rules have kept out of its context
 * (`suppression_stats`), read from the stored rows themselves: each carries
 * the record a suppress rule stamped on it as it arrived
 * (`metadata.suppressed = { rule, eventType }`, the framework's
 * suppressedRow). The rows are the record, so the counts cover every start
 * of the host and follow the branch the store is on, and nothing beside
 * them is kept.
 */

/** A stored row as these stats read it: the parts of context-manager's StoredMessage they use. */
export interface SuppressionStatsRow {
  id: string;
  timestamp: Date | number | string;
  content: ReadonlyArray<{ type: string; text?: unknown }>;
  metadata?: Record<string, unknown>;
}

/** A rule in gate.json, as the stats name it. */
export interface SuppressRuleInForce {
  name: string;
  /** Events it suppressed since this process started (the gate's matchCount for it). */
  sinceStart: number;
}

export interface SuppressionStatsOptions {
  /** Only this rule's rows. */
  rule?: string;
  /** How many of each rule's newest rows to show, with a preview. Default 3, at most 20. */
  recent?: number;
  /** Only rows stored at or after this time (ms). */
  sinceMs?: number;
}

/** One suppressed row, as the stats show it. */
export interface SuppressedEventShown {
  id: string;
  at: string;
  eventType: string;
  source?: string;
  channel?: string;
  author?: string;
  preview: string;
}

/** One rule's stats. */
export interface RuleSuppressionStats {
  rule: string;
  /** Whether gate.json has a suppress rule of that name now. */
  inForce: boolean;
  /** Present for a rule in force: what it suppressed since this process started. */
  sinceStart?: number;
  /** Stored rows it suppressed (within `since`, when given). */
  suppressed: number;
  /** Their text, in characters. */
  characters: number;
  first?: string;
  last?: string;
  /** Rows by the server (or module source) they came from, the most first; past ten, the rest as "(others)". */
  bySource: Record<string, number>;
  /** Rows by the event type they arrived as. */
  byEventType: Record<string, number>;
  /** The newest rows, newest first. */
  recent: SuppressedEventShown[];
}

export interface SuppressionStats {
  rules: RuleSuppressionStats[];
  /** Every stored suppressed row counted (within `since`, when given). */
  total: number;
  totalCharacters: number;
}

/** Longest preview shown, in characters. */
export const SUPPRESSION_PREVIEW_CHARS = 160;
/** Most recent rows shown per rule. */
export const MAX_RECENT = 20;
const DEFAULT_RECENT = 3;
const MAX_KEYS = 10;

/** The record a row carries when a suppress rule took it, or undefined. */
export function suppressionRecordOf(metadata: Record<string, unknown> | undefined): { rule: string; eventType?: string; source?: string } | undefined {
  const record = metadata?.suppressed;
  if (!record || typeof record !== 'object') return undefined;
  const { rule, eventType, source } = record as { rule?: unknown; eventType?: unknown; source?: unknown };
  if (typeof rule !== 'string') return undefined;
  return {
    rule,
    ...(typeof eventType === 'string' && eventType !== '' ? { eventType } : {}),
    ...(typeof source === 'string' && source !== '' ? { source } : {}),
  };
}

/** Where a suppressed row came from: the source its record names (a module's, which its metadata may not), else its server. */
function sourceOf(row: SuppressionStatsRow, record: { source?: string } | undefined): string | undefined {
  if (record?.source) return record.source;
  const serverId = row.metadata?.serverId;
  return typeof serverId === 'string' && serverId !== '' ? serverId : undefined;
}

/** The author a row names: a channel message's `author.name`, or a push event's `authorName`. */
function authorOf(md: Record<string, unknown>): string | undefined {
  const name = (md.author as { name?: unknown } | undefined)?.name ?? md.authorName;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

const textOf = (row: SuppressionStatsRow): string =>
  row.content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n');

const msOf = (timestamp: SuppressionStatsRow['timestamp']): number =>
  timestamp instanceof Date ? timestamp.getTime() : typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);

const isoOf = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown');

/** A text on one line, cut at SUPPRESSION_PREVIEW_CHARS characters (code points), with an ellipsis where cut. */
function previewOf(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const chars = [...line];
  return chars.length <= SUPPRESSION_PREVIEW_CHARS ? line : `${chars.slice(0, SUPPRESSION_PREVIEW_CHARS - 1).join('')}…`;
}

/** Counts, the largest first; past MAX_KEYS, the rest summed as "(others)". Built from entries, so any name, "__proto__" included, is a key of its own. */
function topCounts(counts: Map<string, number>): Record<string, number> {
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const entries: Array<[string, number]> = sorted.slice(0, MAX_KEYS);
  const rest = sorted.slice(MAX_KEYS).reduce((sum, [, n]) => sum + n, 0);
  if (rest > 0) entries.push(['(others)', rest]);
  return Object.fromEntries(entries);
}

function shown(row: SuppressionStatsRow, record: { eventType?: string; source?: string } | undefined): SuppressedEventShown {
  const md = row.metadata ?? {};
  const source = sourceOf(row, record);
  const channel = typeof md.channelId === 'string' && md.channelId !== '' ? md.channelId : undefined;
  const author = authorOf(md);
  return {
    id: row.id,
    at: isoOf(msOf(row.timestamp)),
    eventType: record?.eventType ?? 'unknown',
    ...(source ? { source } : {}),
    ...(channel ? { channel } : {}),
    ...(author ? { author } : {}),
    preview: previewOf(textOf(row)),
  };
}

/**
 * The stats for `rows` (a message slot, oldest first), with every suppress
 * rule in force listed even where it has hidden nothing yet. Rules in force
 * come first, in gate.json's order; rules no longer in force follow, the
 * most recently active first.
 */
export function suppressionStats(
  rows: Iterable<SuppressionStatsRow>,
  inForce: readonly SuppressRuleInForce[],
  opts: SuppressionStatsOptions = {},
): SuppressionStats {
  const recentWanted = Math.max(0, Math.min(MAX_RECENT, Math.floor(opts.recent ?? DEFAULT_RECENT)));
  interface Tally {
    suppressed: number; characters: number; first: number; last: number;
    bySource: Map<string, number>; byEventType: Map<string, number>;
    recent: Array<{ row: SuppressionStatsRow; record: { eventType?: string; source?: string } }>;
  }
  const tallies = new Map<string, Tally>();
  let total = 0;
  let totalCharacters = 0;
  for (const row of rows) {
    const record = suppressionRecordOf(row.metadata);
    if (!record) continue;
    if (opts.rule !== undefined && record.rule !== opts.rule) continue;
    const at = msOf(row.timestamp);
    if (opts.sinceMs !== undefined && !(at >= opts.sinceMs)) continue;
    let tally = tallies.get(record.rule);
    if (!tally) {
      tally = { suppressed: 0, characters: 0, first: at, last: at, bySource: new Map(), byEventType: new Map(), recent: [] };
      tallies.set(record.rule, tally);
    }
    const characters = [...textOf(row)].length;
    tally.suppressed++;
    tally.characters += characters;
    if (at < tally.first) tally.first = at;
    if (at > tally.last) tally.last = at;
    const source = sourceOf(row, record) ?? '(none)';
    tally.bySource.set(source, (tally.bySource.get(source) ?? 0) + 1);
    const eventType = record.eventType ?? 'unknown';
    tally.byEventType.set(eventType, (tally.byEventType.get(eventType) ?? 0) + 1);
    if (recentWanted > 0) {
      tally.recent.push({ row, record });
      if (tally.recent.length > recentWanted) tally.recent.shift();
    }
    total++;
    totalCharacters += characters;
  }

  const ruleStats = (name: string, rule: SuppressRuleInForce | undefined): RuleSuppressionStats => {
    const tally = tallies.get(name);
    return {
      rule: name,
      inForce: rule !== undefined,
      ...(rule !== undefined ? { sinceStart: rule.sinceStart } : {}),
      suppressed: tally?.suppressed ?? 0,
      characters: tally?.characters ?? 0,
      ...(tally ? { first: isoOf(tally.first), last: isoOf(tally.last) } : {}),
      bySource: tally ? topCounts(tally.bySource) : {},
      byEventType: tally ? topCounts(tally.byEventType) : {},
      recent: tally ? tally.recent.slice().reverse().map(({ row, record }) => shown(row, record)) : [],
    };
  };

  const listed = new Set<string>();
  const out: RuleSuppressionStats[] = [];
  for (const rule of inForce) {
    if (listed.has(rule.name) || (opts.rule !== undefined && rule.name !== opts.rule)) continue;
    listed.add(rule.name);
    out.push(ruleStats(rule.name, rule));
  }
  const gone = [...tallies.keys()].filter((name) => !listed.has(name))
    .sort((a, b) => tallies.get(b)!.last - tallies.get(a)!.last || a.localeCompare(b));
  for (const name of gone) out.push(ruleStats(name, undefined));
  return { rules: out, total, totalCharacters };
}

/** One suppressed row, as a dump or the review reads it: its text in full, any other block named. */
export interface SuppressedEventRecord {
  id: string;
  /** ISO 8601. */
  at: string;
  rule: string;
  eventType: string;
  source?: string;
  channel?: string;
  author?: string;
  /** Its text blocks, joined; a block of another kind as `[image]`, `[audio]` and so on. */
  text: string;
}

export interface SuppressedRecordsOptions {
  rule?: string;
  /** Rows stored at or after this time (ms). */
  sinceMs?: number;
  /** Rows stored before this time (ms). */
  untilMs?: number;
}

/** A row's content as text: text blocks as written, any other block named in brackets. */
function fullTextOf(row: SuppressionStatsRow): string {
  return row.content
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : `[${b.type}]`))
    .join('\n');
}

/** The suppressed rows among `rows`, oldest first, their text in full; times are when each was stored. */
export function suppressedRecords(rows: Iterable<SuppressionStatsRow>, opts: SuppressedRecordsOptions = {}): SuppressedEventRecord[] {
  const out: SuppressedEventRecord[] = [];
  for (const row of rows) {
    const record = suppressionRecordOf(row.metadata);
    if (!record || (opts.rule !== undefined && record.rule !== opts.rule)) continue;
    const at = msOf(row.timestamp);
    if (opts.sinceMs !== undefined && !(at >= opts.sinceMs)) continue;
    if (opts.untilMs !== undefined && !(at < opts.untilMs)) continue;
    const { source, channel, author } = shown(row, record);
    out.push({
      id: row.id,
      at: isoOf(at),
      rule: record.rule,
      eventType: record.eventType ?? 'unknown',
      ...(source ? { source } : {}),
      ...(channel ? { channel } : {}),
      ...(author ? { author } : {}),
      text: fullTextOf(row),
    });
  }
  return out;
}

/** A dump's file formats: one JSON object a line, or a transcript to read. */
export type SuppressedDumpFormat = 'jsonl' | 'text';

/**
 * A dump's file content, at most `maxBytes` (UTF-8): the newest records that
 * fit, oldest first, and how many older ones were left out to fit. A
 * transcript opens with a header naming what it holds (`title`, given how
 * many it holds and the oldest's time) and, when some were left out, how many.
 */
export function renderSuppressedDump(
  records: readonly SuppressedEventRecord[],
  format: SuppressedDumpFormat,
  opts: { maxBytes: number; title: string | ((written: number, first: string) => string) },
): { content: string; written: number; omitted: number } {
  const entry = (r: SuppressedEventRecord): string => format === 'jsonl'
    ? `${JSON.stringify(r)}\n`
    : `[${r.at}] ${r.rule} · ${r.eventType}${r.source ? ` · ${r.source}` : ''}${r.channel ? ` · ${r.channel}` : ''}`
      + `${r.author ? ` · ${r.author}` : ''} · ${r.id}\n${r.text}\n\n`;
  const entries = records.map(entry);
  const titleOf = (from: number): string => typeof opts.title === 'string'
    ? opts.title
    : opts.title(entries.length - from, records[from]?.at ?? '');
  const header = (from: number): string => format === 'jsonl'
    ? ''
    : `# ${titleOf(from)}\n${from > 0 ? `(${from} older events left out to fit)\n` : ''}\n`;
  // The most records, newest first, that fit beside the header they make:
  // the header names how many were left out, so it's sized for each count.
  let bytes = 0;
  let from = entries.length;
  let best = entries.length;
  while (from > 0) {
    bytes += Buffer.byteLength(entries[from - 1]!);
    from--;
    if (Buffer.byteLength(header(from)) + bytes <= opts.maxBytes) best = from;
    else if (bytes > opts.maxBytes) break;
  }
  if (best === entries.length) return { content: '', written: 0, omitted: entries.length };
  return { content: header(best) + entries.slice(best).join(''), written: entries.length - best, omitted: best };
}

/**
 * The deferred-write queue an earlier release left on disk, read once at
 * boot (#291, AF-6).
 *
 * Releases before #291's presentation index held a context write in a queue
 * while its agent's turn was alive or the host was quiesced, and stored it
 * at that agent's next boundary. While quiesced, and from a write that
 * reached or may have reached its record until the queue drained, the queue
 * was mirrored to `recovery/deferred-writes.json` beside the store, or, with
 * no recovery path, to the store's `framework/deferred-writes` slot. This
 * release stores every write at once and keeps no queue, so a record such a
 * release left is read here, and the framework stores each of its writes
 * once at boot (AgentFramework.importPersistedDeferredWrites) and clears the
 * record. Like that importer, this module is for one release: the release
 * after it deletes both.
 *
 * Nothing here touches a store. It reads the record's value, refuses one
 * that isn't a queue, drops entries its readers can't handle, keeps one entry
 * per id, and orders them as they arrived.
 */
import { randomUUID } from 'node:crypto';
import type { ContentBlock } from '@animalabs/membrane';
import type { MessageMetadata } from '@animalabs/context-manager';

/** One write an earlier release queued, as its record held it. */
export interface PersistedDeferredWrite {
  /** Its durable identity: a copy of it that landed carries it as `metadata.deferredWriteId`. */
  id: string;
  /** Where it came in arrival order, 1..N over the entries kept. */
  seq: number;
  participant: string;
  content: ContentBlock[];
  metadata?: MessageMetadata;
  /** The agent it was for. Absent means the primary. */
  forAgent?: string;
  /** When the earlier release first held it, in ms since the epoch, where the record says. */
  heldAt?: number;
  /**
   * Set where a write of it threw and its store couldn't be read to tell
   * whether it landed: before it is stored, its target's whole branch is
   * searched for its id.
   */
  landing?: 'unknown';
}

/** What a queue's record held, as the importer takes it. */
export interface PersistedQueue {
  /** Its writes, in arrival order. */
  entries: PersistedDeferredWrite[];
  /**
   * Per target agent, where its store stood when the oldest write handed to
   * it and not yet acknowledged was handed over: the boot dedup scans from
   * there (0 for an agent not named, the whole store).
   */
  scanFrom: Map<string, number>;
  /**
   * Whether reading it dropped or renumbered anything (a malformed entry, a
   * repeated id, a missing or invalid seq), so a record cleared or written
   * again doesn't name those again.
   */
  changed: boolean;
}

/** Where a queue's record is: the recovery file, or the store's slot. */
export interface DeferredWritesRecord {
  /** The recovery file the value was read from; absent where it was the slot's. */
  file?: string;
  /** The store's slot for it (framework/deferred-writes). */
  slotId: string;
}

/** A stored JSON value's kind, for a refusal that names what it found without its content. */
function jsonKind(value: unknown): string {
  return value === null ? 'null'
    : Array.isArray(value) ? 'an array'
      : typeof value === 'object' ? 'an object'
        : `a ${typeof value}`;
}

/**
 * The refusal of a boot whose queue record can't be taken: it could not be
 * read (`cause`), or it holds something other than a queue (`problem`
 * alone). Either way the record is left as it is, and the error says what
 * lets the framework start.
 */
export function deferredWritesRefusal(record: DeferredWritesRecord, problem: string, cause?: unknown): Error {
  const { file, slotId } = record;
  return new Error(
    `the deferred context writes (${file ?? slotId}) ${problem}. The framework doesn't start without them: an earlier ` +
      `version left them queued, and they are stored at boot, ahead of anything newer. ` +
      (file
        ? `The file is unchanged, and the framework starts once ${cause === undefined
          ? 'it holds a queue of writes, such as {"version":1,"pending":[]} for none. Removing it reads the queue ' +
            `from ${slotId} instead, which the file's writes don't keep, so it imports whatever older ` +
            `queue is there, or none`
          : 'it can be read'}.`
        : cause === undefined
          ? `They're unchanged, and starting again won't help until they're repaired.`
          : `They're unchanged, and the framework starts once they can be read.`),
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Read a queue record's value: the recovery file's document, or the slot's
 * value where there is no file (`record.file` absent).
 *
 * - Nothing stored is an empty queue: no file and nothing in the slot. A file
 *   that holds null isn't a queue, since no release writes one.
 * - The forms releases wrote are read: a bare array (the slot's first form),
 *   and `{ pending, scanFrom? }` (version 1 and 2 files, version 2 slots).
 *   Anything else is refused (deferredWritesRefusal).
 * - An entry the importer can't store is dropped with a line naming it: one
 *   whose participant isn't text, whose content isn't an array, that holds a
 *   block that isn't an object, or whose `forAgent` is present but not a
 *   name. A release wrote `forAgent` only as a non-empty name, so another
 *   value is damage or a hand edit, and the agent it meant can't be known.
 * - One entry per id: an id that comes again is dropped with a line, the
 *   first entry with it kept. An entry with no id is given one, with a line:
 *   a copy of it that landed carries the id it lost, so the boot dedup can't
 *   find it, and it may be stored again.
 * - `heldAt` is kept where it is a time a Date can hold.
 * - Arrival order: entries whose seq is a positive whole number up to
 *   Number.MAX_SAFE_INTEGER by seq, then, in record order, those without one
 *   (a record from before seq, in write order already) or with another value,
 *   which is named. They are numbered 1..N in that order.
 */
export function readPersistedDeferredWrites(
  raw: unknown,
  record: DeferredWritesRecord,
  log: (line: string) => void,
): PersistedQueue {
  const empty: PersistedQueue = { entries: [], scanFrom: new Map(), changed: false };
  if (!record.file && (raw === null || raw === undefined)) return empty;
  const doc = (Array.isArray(raw) ? { pending: raw } : raw !== null && typeof raw === 'object' ? raw : undefined) as
    { pending?: unknown; scanFrom?: unknown } | undefined;
  if (!doc || !Array.isArray(doc.pending)) {
    throw deferredWritesRefusal(record, doc
      ? `hold an object whose pending is ${doc.pending === undefined ? 'missing' : jsonKind(doc.pending)}, not a list of writes`
      : `hold ${jsonKind(raw)}, not a queue of writes`);
  }
  const data = doc.pending as unknown[];
  if (data.length === 0) return empty;
  const scanFrom = new Map<string, number>();
  if (doc.scanFrom && typeof doc.scanFrom === 'object') {
    for (const [k, v] of Object.entries(doc.scanFrom as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) scanFrom.set(k, Math.max(0, Math.floor(v)));
    }
  }
  type Read = { participant: string; content: ContentBlock[]; metadata?: MessageMetadata; forAgent?: string; id?: unknown; seq?: unknown; heldAt?: unknown; landing?: unknown };
  const wellFormed = (m: unknown): m is Read => {
    if (!m || typeof m !== 'object') return false;
    const { participant, content, forAgent } = m as { participant?: unknown; content?: unknown; forAgent?: unknown };
    return typeof participant === 'string'
      && Array.isArray(content) && content.every((b) => !!b && typeof b === 'object')
      && (forAgent === undefined || (typeof forAgent === 'string' && forAgent !== ''));
  };
  const malformed = data.filter((m) => !wellFormed(m));
  for (const m of malformed) {
    // What the entry holds there: a value that isn't text by its type.
    const field = (key: string): string => {
      const value = m && typeof m === 'object' ? (m as Record<string, unknown>)[key] : undefined;
      if (typeof value === 'string') return value;
      if (value === undefined) return `no ${key}`;
      return `${key} ${value === null ? 'null' : `of type ${typeof value}`}`;
    };
    log(`[host-mode] a recovered deferred context write is malformed and was dropped: ${field('id')} (${field('participant')})`);
  }
  const seen = new Set<string>();
  const kept: Array<Omit<PersistedDeferredWrite, 'seq'> & { seq?: unknown }> = [];
  let duplicates = 0;
  for (const m of data.filter(wellFormed)) {
    const hasId = typeof m.id === 'string' && m.id !== '';
    const id = hasId ? (m.id as string) : randomUUID();
    if (!hasId) log(`[host-mode] a recovered deferred context write (${m.participant}) has no id; it is given ${id}`);
    if (seen.has(id)) {
      duplicates++;
      log(`[host-mode] a recovered deferred context write repeats id ${id} (${m.participant}) and was dropped; the first entry with that id is kept`);
      continue;
    }
    seen.add(id);
    kept.push({
      id,
      seq: m.seq,
      participant: m.participant,
      content: m.content,
      ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
      ...(m.forAgent !== undefined ? { forAgent: m.forAgent } : {}),
      // A Date holds times within 8.64e15 ms of the epoch.
      ...(typeof m.heldAt === 'number' && Math.abs(m.heldAt) <= 8.64e15 ? { heldAt: m.heldAt } : {}),
      ...(m.landing === 'unknown' ? { landing: 'unknown' as const } : {}),
    });
  }
  const validSeq = (seq: unknown): seq is number => Number.isSafeInteger(seq) && (seq as number) > 0;
  const unnumbered = kept.filter((m) => !validSeq(m.seq));
  for (const m of unnumbered) {
    if (m.seq === undefined) continue;
    // A value that isn't a number is named by its type: it could be any size.
    const seq = typeof m.seq === 'number' ? String(m.seq) : m.seq === null ? 'null' : `of type ${typeof m.seq}`;
    log(
      `[host-mode] a recovered deferred context write (${m.id}) has seq ${seq}, not a positive ` +
        `whole number up to Number.MAX_SAFE_INTEGER; it is queued after the others`,
    );
  }
  const ordered = [...kept.filter((m) => validSeq(m.seq)).sort((a, b) => (a.seq as number) - (b.seq as number)), ...unnumbered];
  return {
    entries: ordered.map((m, i) => ({ ...m, seq: i + 1 })),
    scanFrom,
    changed: malformed.length > 0 || duplicates > 0 || unnumbered.length > 0,
  };
}

/**
 * Whether an entry holds a tool block (tool_use or tool_result): of what a
 * release queued, only the puppet's pair, which was the agent's own round,
 * queued behind a turn that had replaced the puppet's reservation.
 */
export function isToolBlockEntry(entry: Pick<PersistedDeferredWrite, 'content'>): boolean {
  return entry.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result');
}

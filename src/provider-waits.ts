/**
 * Provider waits: a provider's stated `retry-after`, kept as a deadline that
 * outlives the process.
 *
 * When a provider answers "retry after N", calling the same model again
 * before then adds traffic the provider has said will fail. The framework
 * therefore records the wait per (agent, model) and admits no call to that
 * model for that agent until it passes. The wait is a fact about the provider,
 * not about the conversation, so it is kept in typed Chronicle records
 * (RecordJournal): a restart honours it, and a branch switch or rollback
 * does not rewind it.
 *
 * - A later, shorter wait for the same (agent, model) never shortens an
 *   outstanding longer one: the binding deadline is the maximum. Requests
 *   that finish at different times can carry different hints.
 * - A wait that cannot be represented as an instant (not a finite
 *   non-negative number, or past the last instant a Date can hold) becomes an
 *   indefinite wait rather than a shorter one, held until explicitly released.
 * - A wait ends when its instant passes (nothing is written), or when an
 *   operator releases it (recorded). Selecting a different model is not a
 *   release: that model proceeds, and the old model's wait still applies if it
 *   is selected again before the wait passes.
 *
 * One writer per record type (RecordJournal's contract): the framework that
 * owns the store.
 */

import type { JsStore } from '@animalabs/chronicle';
import { RecordJournal } from './record-journal.js';
import { safeSlice } from './safe-slice.js';

export const PROVIDER_WAIT_RECORD_TYPE = 'framework/provider-wait';

/** Checkpoint the reduced waits after this many entries, bounding replay at open. */
const CHECKPOINT_EVERY = 64;
/** The last instant a JavaScript Date can represent (ECMA-262 time value range). */
const MAX_DATE_MS = 8.64e15;

export interface ProviderWait {
  agent: string;
  model: string;
  /** Epoch ms before which no call is admitted; null holds until released. */
  until: number | null;
  /** Why, in the provider's words (bounded by the caller). */
  reason: string;
  /** When the binding wait was recorded. */
  setAt: number;
}

type ProviderWaitEntry =
  | { kind: 'set'; agent: string; model: string; until: number | null; reason: string; at: number }
  | { kind: 'released'; agent: string; model: string | null; by: string; at: number };

interface ProviderWaitSnapshot {
  waits: ProviderWait[];
}

/**
 * The instant a stated wait ends, or null when it cannot be represented:
 * the wait is then held until released, never shortened.
 */
export function waitDeadline(retryAfterMs: unknown, now: number): number | null {
  if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return null;
  const until = Math.ceil(now + retryAfterMs);
  if (!Number.isSafeInteger(until) || until > MAX_DATE_MS) return null;
  return until;
}

const keyOf = (agent: string, model: string): string => `${agent}\u0000${model}`;

/** Whether `next` binds longer than `current` (null is longer than any instant). */
function outlasts(next: number | null, current: number | null): boolean {
  if (current === null) return false;
  if (next === null) return true;
  return next > current;
}

function reduce(waits: Map<string, ProviderWait>, entry: ProviderWaitEntry): void {
  if (entry.kind === 'set') {
    const key = keyOf(entry.agent, entry.model);
    const current = waits.get(key);
    if (current && !outlasts(entry.until, current.until)) return;
    waits.set(key, { agent: entry.agent, model: entry.model, until: entry.until, reason: entry.reason, setAt: entry.at });
    return;
  }
  for (const [key, wait] of waits) {
    if (wait.agent === entry.agent && (entry.model === null || wait.model === entry.model)) waits.delete(key);
  }
}

export interface ProviderWaitChange {
  /** The binding wait after this call. */
  wait: ProviderWait;
  /** False when an outstanding longer (or indefinite) wait already binds. */
  changed: boolean;
}

/**
 * One wait a release lifted. `release` says how far that reaches:
 * - 'recorded': the release is durably recorded, so a restart keeps it;
 * - 'pending': it binds in this process, but its record has not landed yet
 *   and is offered again at the next act (a restart before then restores the
 *   wait);
 * - 'in-process override': the hold that stands for unreadable recorded
 *   waits, lifted for this process only (a restart that still cannot read
 *   them holds again). The release itself is still offered to the journal,
 *   so once the history can be read it applies there, in order.
 */
export interface ProviderWaitRelease {
  wait: ProviderWait;
  release: 'recorded' | 'pending' | 'in-process override';
}

/** How often a binding act this process could not record is offered to the journal again, absent another act. */
const RETRY_WRITE_MS = 30_000;
/** How often unreadable recorded waits are read again, by default (`retryReadMs`). */
const RETRY_READ_MS = 30_000;
/**
 * The model that stands for every model: how list() shows the hold for
 * unreadable records, and what release() takes as "every model" (the same as
 * omitting it). No provider model is named that.
 */
export const EVERY_MODEL = '*';

/**
 * Whether a release's `model`, as an operator surface receives it, names a
 * scope: omitted or EVERY_MODEL for every model, any other nonempty string
 * for that model. Anything else is malformed and is refused, never taken as
 * "every model".
 */
export function isReleaseModel(model: unknown): model is string | undefined {
  return model === undefined || (typeof model === 'string' && model !== '');
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const live = (wait: ProviderWait | undefined, now: number): ProviderWait | undefined =>
  wait && (wait.until === null || wait.until > now) ? wait : undefined;

// What a record must hold to be read as provider waits: every field the
// reduction, or a reader of its waits, uses. A record that parses but lacks
// one is unreadable (fail closed), never read as "no waits".
const fieldsOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const isText = (value: unknown): value is string => typeof value === 'string';
/** A number a Date can hold (NaN and the infinities fail the comparison). */
const isInstant = (value: unknown): value is number => typeof value === 'number' && Math.abs(value) <= MAX_DATE_MS;
const isDeadline = (value: unknown): value is number | null => value === null || isInstant(value);

function isWait(value: unknown): value is ProviderWait {
  const wait = fieldsOf(value);
  return wait !== undefined && isText(wait.agent) && isText(wait.model) && isDeadline(wait.until) &&
    isText(wait.reason) && isInstant(wait.setAt);
}

/** A release's `by` and `at` are never read back, so they are not required. */
function isEntry(value: unknown): value is ProviderWaitEntry {
  const entry = fieldsOf(value);
  if (entry === undefined || !isText(entry.agent)) return false;
  if (entry.kind === 'set') {
    return isText(entry.model) && isDeadline(entry.until) && isText(entry.reason) && isInstant(entry.at);
  }
  return entry.kind === 'released' && (entry.model === null || isText(entry.model));
}

function isSnapshot(value: unknown): value is ProviderWaitSnapshot {
  const waits = fieldsOf(value)?.waits;
  if (!Array.isArray(waits) || !waits.every(isWait)) return false;
  // The writer keeps one wait per (agent, model). A repeated key has no
  // reading that is sure to keep the longer wait.
  return new Set(waits.map((wait) => keyOf(wait.agent, wait.model))).size === waits.length;
}

export class ProviderWaits {
  /**
   * The reduction of exactly what the journal holds: its latest checkpoint and
   * every entry after it, as loaded or as appended and synced. A checkpoint
   * records this, so it covers the same ordered acts the journal does.
   */
  private durable = new Map<string, ProviderWait>();
  /**
   * Acts of this process not yet known to be durably recorded, in the order
   * they were made. They bind here from the moment they are made, and are
   * offered to the journal, in order, at every later act until one lands.
   */
  private readonly pending: ProviderWaitEntry[] = [];
  /** What binds in this process: `durable` with `pending` applied in order. */
  private view = new Map<string, ProviderWait>();
  /**
   * Set while the recorded waits cannot be read. Their absence is then
   * unknown, not "no waits": every (agent, model) is held (fail closed) until
   * they can be read or an operator releases the agent's waits. Releases made
   * meanwhile are kept in `waived` (agent, model or EVERY_MODEL) for this
   * process; a restart that still cannot read them holds again.
   */
  private unreadable: { error: string; at: number; lastTry: number; waived: Set<string> } | null = null;
  private lastWriteTry = 0;
  /**
   * How often unreadable recorded waits are read again. The hold that stands
   * for them ends without any act (the records read again), so whoever holds
   * on a wait with no deadline asks active() again this often.
   */
  readonly retryReadMs: number;
  private readonly store: JsStore | null;
  private readonly journal: RecordJournal<ProviderWaitEntry, ProviderWaitSnapshot> | null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  /** `store` null keeps waits in memory only (a framework without a store has no restart to survive). */
  constructor(store: JsStore | null, opts: { now?: () => number; log?: (line: string) => void; retryReadMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.error(line));
    this.retryReadMs = opts.retryReadMs ?? RETRY_READ_MS;
    this.store = store;
    this.journal = store ? new RecordJournal<ProviderWaitEntry, ProviderWaitSnapshot>(store, { type: PROVIDER_WAIT_RECORD_TYPE }) : null;
    this.load();
  }

  /**
   * The wait binding (agent, model) now, if any. While the recorded waits
   * cannot be read, an indefinite wait saying so, unless an operator released
   * this agent's waits since.
   */
  active(agent: string, model: string): ProviderWait | undefined {
    this.retry();
    if (this.unreadable && !this.waived(agent, model)) return this.unreadableWait(agent, model);
    const wait = live(this.view.get(keyOf(agent, model)), this.now());
    return wait ? { ...wait } : undefined;
  }

  /**
   * Every wait binding now, for one agent or all. While the recorded waits
   * cannot be read, it leads with an indefinite wait on EVERY_MODEL saying
   * so (for the agent asked about, or for EVERY_MODEL agents).
   */
  list(agent?: string): ProviderWait[] {
    this.retry();
    const result: ProviderWait[] = [];
    if (this.unreadable && (agent === undefined || !this.waived(agent, EVERY_MODEL))) {
      result.push(this.unreadableWait(agent ?? EVERY_MODEL, EVERY_MODEL));
    }
    const now = this.now();
    for (const wait of this.view.values()) {
      if (agent !== undefined && wait.agent !== agent) continue;
      if (live(wait, now)) result.push({ ...wait });
    }
    return result;
  }

  /** Record a provider's stated wait for (agent, model). */
  set(agent: string, model: string, retryAfterMs: unknown, reason: string): ProviderWaitChange {
    const at = this.now();
    // Decide against what the journal now holds: an earlier ambiguous write
    // is reconciled first.
    this.reconcile();
    const entry: ProviderWaitEntry = { kind: 'set', agent, model, until: waitDeadline(retryAfterMs, at), reason, at };
    const before = live(this.view.get(keyOf(agent, model)), at);
    const changed = before === undefined || outlasts(entry.until, before.until);
    if (changed) this.apply(entry);
    // An unchanged binding is not proof it was recorded: offer what is pending.
    this.flush();
    return { wait: { ...this.view.get(keyOf(agent, model))! }, changed };
  }

  /**
   * Release (agent, model)'s wait, or every wait of the agent when `model` is
   * omitted; recorded. While the recorded waits cannot be read, it also lifts
   * the hold that stands for them, exactly as far as the release names (that
   * model, or every model), in this process only. Each lifted wait says how
   * far its release reaches (ProviderWaitRelease).
   */
  release(agent: string, model: string | undefined, by: string): ProviderWaitRelease[] {
    // EVERY_MODEL, as list() shows it, names every model: the same release
    // as omitting the model, in this process and in the record alike.
    if (model === EVERY_MODEL) model = undefined;
    this.reconcile();
    const now = this.now();
    const released = [...this.view.values()]
      .filter((wait) => wait.agent === agent && (model === undefined || wait.model === model) && live(wait, now))
      .map((wait) => ({ ...wait }));
    const target = model ?? EVERY_MODEL;
    let override: ProviderWait | undefined;
    if (this.unreadable && !this.waived(agent, target)) {
      override = this.unreadableWait(agent, target);
      this.unreadable.waived.add(keyOf(agent, target));
    }
    if (released.length === 0 && !override) return [];
    const entry: ProviderWaitEntry = { kind: 'released', agent, model: model ?? null, by, at: now };
    this.apply(entry);
    this.flush();
    const recorded = !this.pending.includes(entry);
    return [
      ...(override ? [{ wait: override, release: 'in-process override' as const }] : []),
      ...released.map((wait) => ({ wait, release: recorded ? 'recorded' as const : 'pending' as const })),
    ];
  }

  private waived(agent: string, model: string): boolean {
    const waived = this.unreadable?.waived;
    return waived !== undefined && (waived.has(keyOf(agent, EVERY_MODEL)) || waived.has(keyOf(agent, model)));
  }

  private unreadableWait(agent: string, model: string): ProviderWait {
    return {
      agent, model, until: null, setAt: this.unreadable!.at,
      reason: `recorded provider waits could not be read (${this.unreadable!.error}); held until they can be read or an operator releases this agent's waits`,
    };
  }

  /** Make an act bind in this process, ahead of its record. */
  private apply(entry: ProviderWaitEntry): void {
    this.pending.push(entry);
    reduce(this.view, entry);
  }

  /** Rebuild what binds from the journal's reduction and this process's pending acts, in order. */
  private rebuildView(): void {
    const view = new Map<string, ProviderWait>();
    for (const [key, wait] of this.durable) view.set(key, { ...wait });
    for (const entry of this.pending) reduce(view, entry);
    this.view = view;
  }

  /**
   * Read the journal into `durable`. A failure leaves the history unreadable
   * (fail closed, reported once), never empty. So does a record that parses
   * but cannot be read as provider waits: a checkpoint also stands for every
   * entry before it, so a malformed one read as empty would drop them all.
   */
  private load(): boolean {
    if (!this.journal) return true;
    const now = this.now();
    try {
      const { snapshot, entries } = this.journal.load();
      // RecordJournal shows a checkpoint whose snapshot is null as no
      // checkpoint at all (it still skips the entries it covers); this writer
      // never writes one, so finding such a record means it is malformed.
      const malformedCheckpoint = snapshot === null
        ? this.store!.getRecordIdsByType(this.journal.checkpointType).length > 0
        : !isSnapshot(snapshot);
      if (malformedCheckpoint) throw new Error('a provider-wait checkpoint is malformed');
      for (const { id, entry } of entries) {
        if (!isEntry(entry)) throw new Error(`provider-wait record ${id} is malformed`);
      }
      const loaded = new Map<string, ProviderWait>();
      for (const wait of snapshot?.waits ?? []) loaded.set(keyOf(wait.agent, wait.model), { ...wait });
      for (const { entry } of entries) reduce(loaded, entry);
      this.durable = loaded;
    } catch (error) {
      if (this.unreadable) {
        this.unreadable.lastTry = now;
      } else {
        this.unreadable = { error: safeSlice(errorText(error), 0, 300), at: now, lastTry: now, waived: new Set() };
        this.log(`[provider-wait] recorded provider waits could not be read (${this.unreadable.error}): ` +
          'no provider call is admitted until they can be read or an operator releases an agent\'s waits ' +
          '(release-provider-wait); inspection is unaffected');
      }
      return false;
    }
    if (this.unreadable) {
      this.log(`[provider-wait] recorded provider waits are readable again; ${loaded(this.durable, now)} bind`);
      this.unreadable = null;
    }
    this.rebuildView();
    return true;
  }

  /** Reconcile an ambiguous write before deciding anything against the journal. */
  private reconcile(): void {
    if (this.journal?.needsReconcile) this.load();
  }

  /** Offer unrecorded acts and unreadable history again, at most every so often, absent other acts. */
  private retry(): void {
    const now = this.now();
    if (this.unreadable && now - this.unreadable.lastTry >= this.retryReadMs) this.load();
    if (this.pending.length > 0 && now - this.lastWriteTry >= RETRY_WRITE_MS) {
      this.reconcile();
      this.flush();
    }
  }

  /**
   * Record pending acts in order, each durable before the next: a lost wait
   * would admit an early call after a crash. The first that fails stays
   * pending with every act after it (they still bind in this process) and is
   * reported; an ambiguous one is reconciled before the next attempt, so an
   * act may be recorded twice, which reduces the same. A checkpoint records
   * the journal's own reduction, never this process's unrecorded acts, and
   * never while the history is unreadable (it would cover entries that were
   * never reduced).
   */
  private flush(): void {
    if (!this.journal) {
      for (const entry of this.pending.splice(0)) reduce(this.durable, entry);
      return;
    }
    this.lastWriteTry = this.now();
    while (this.pending.length > 0) {
      if (this.journal.needsReconcile && !this.load()) return;
      if (this.journal.needsReconcile) return;
      const entry = this.pending[0]!;
      try {
        this.journal.append(entry, { durable: true });
      } catch (error) {
        this.log(`[provider-wait] could not record ${entry.kind} for agent=${entry.agent} model=${entry.model ?? EVERY_MODEL} ` +
          `(${this.pending.length} act(s) pending); it holds in this process and is offered again at the next act: ${safeSlice(errorText(error), 0, 300)}`);
        return;
      }
      this.pending.shift();
      reduce(this.durable, entry);
    }
    if (this.unreadable || this.journal.entriesSinceCheckpoint < CHECKPOINT_EVERY) return;
    const now = this.now();
    try {
      this.journal.checkpoint({ waits: [...this.durable.values()].filter((wait) => live(wait, now)) }, { durable: true });
    } catch (error) {
      this.log(`[provider-wait] could not checkpoint provider waits; the journal still replays in full: ${safeSlice(errorText(error), 0, 300)}`);
    }
  }
}

function loaded(waits: Map<string, ProviderWait>, now: number): number {
  let count = 0;
  for (const wait of waits.values()) if (live(wait, now)) count++;
  return count;
}

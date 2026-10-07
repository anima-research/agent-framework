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

export class ProviderWaits {
  private readonly waits = new Map<string, ProviderWait>();
  private readonly journal: RecordJournal<ProviderWaitEntry, ProviderWaitSnapshot> | null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  /**
   * `store` null keeps waits in memory only (a framework without a store has
   * no restart to survive). Loading replays the journal; a journal that
   * cannot be read is reported and the framework starts with no waits, the
   * same as before this existed, rather than refusing to start.
   */
  constructor(store: JsStore | null, opts: { now?: () => number; log?: (line: string) => void } = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.error(line));
    this.journal = store ? new RecordJournal<ProviderWaitEntry, ProviderWaitSnapshot>(store, { type: PROVIDER_WAIT_RECORD_TYPE }) : null;
    try {
      this.reload();
    } catch (error) {
      this.log(`[provider-wait] could not read recorded provider waits; starting with none: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The wait binding (agent, model) now, if any. */
  active(agent: string, model: string): ProviderWait | undefined {
    const key = keyOf(agent, model);
    const wait = this.waits.get(key);
    if (!wait) return undefined;
    if (wait.until !== null && wait.until <= this.now()) {
      this.waits.delete(key);
      return undefined;
    }
    return wait;
  }

  /** Every wait binding now, for one agent or all. */
  list(agent?: string): ProviderWait[] {
    const result: ProviderWait[] = [];
    for (const wait of [...this.waits.values()]) {
      if (agent !== undefined && wait.agent !== agent) continue;
      const live = this.active(wait.agent, wait.model);
      if (live) result.push({ ...live });
    }
    return result;
  }

  /** Record a provider's stated wait for (agent, model). */
  set(agent: string, model: string, retryAfterMs: unknown, reason: string): ProviderWaitChange {
    const at = this.now();
    const entry: ProviderWaitEntry = { kind: 'set', agent, model, until: waitDeadline(retryAfterMs, at), reason, at };
    const before = this.active(agent, model);
    reduce(this.waits, entry);
    const wait = this.waits.get(keyOf(agent, model))!;
    const changed = before === undefined || wait !== before;
    if (changed) this.persist(entry);
    return { wait: { ...wait }, changed };
  }

  /** Release (agent, model)'s wait, or every wait of the agent; recorded. */
  release(agent: string, model: string | undefined, by: string): ProviderWait[] {
    const released = this.list(agent).filter((wait) => model === undefined || wait.model === model);
    if (released.length === 0) return [];
    const entry: ProviderWaitEntry = { kind: 'released', agent, model: model ?? null, by, at: this.now() };
    reduce(this.waits, entry);
    this.persist(entry);
    return released;
  }

  private reload(): void {
    if (!this.journal) return;
    const { snapshot, entries } = this.journal.load();
    const loaded = new Map<string, ProviderWait>();
    for (const wait of snapshot?.waits ?? []) loaded.set(keyOf(wait.agent, wait.model), wait);
    for (const { entry } of entries) reduce(loaded, entry);
    // What this process holds in memory but could not persist still binds.
    for (const wait of this.waits.values()) {
      reduce(loaded, { kind: 'set', agent: wait.agent, model: wait.model, until: wait.until, reason: wait.reason, at: wait.setAt });
    }
    this.waits.clear();
    for (const [key, wait] of loaded) this.waits.set(key, wait);
  }

  /**
   * Durable before the caller acts: a lost wait would admit one early call
   * after a crash. A failed write leaves the wait binding in memory (it still
   * holds in this process) and is reported; an ambiguous one is reconciled
   * before the next write.
   */
  private persist(entry: ProviderWaitEntry): void {
    if (!this.journal) return;
    try {
      if (this.journal.needsReconcile) this.reload();
      this.journal.append(entry, { durable: true });
      if (this.journal.entriesSinceCheckpoint >= CHECKPOINT_EVERY) {
        this.journal.checkpoint({ waits: this.list() });
      }
    } catch (error) {
      this.log(`[provider-wait] could not record ${entry.kind} for agent=${entry.agent} model=${entry.model ?? '*'}; it holds in this process only: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

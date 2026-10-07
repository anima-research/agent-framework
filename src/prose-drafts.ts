/**
 * Held prose drafts: a resident's plain speech that was not sent.
 *
 * Plain speech is held back for reasons that are right in themselves: an
 * explicit send in the same round suppresses the round's prose (so a "sent
 * it" postscript is not posted twice), a turn may have no destination, two
 * conversations may compete for an unaddressed reply, and a malformed or
 * unresolvable routing prefix bounces. Before drafts, the held words were
 * kept only as a count (or, in explicit mode, as one in-memory latest-wins
 * clipboard): the law was right, and the penalty was amnesia. A draft keeps
 * the exact words until the resident resends or dismisses them.
 *
 * The boundary is publication and agency, not visibility: a draft is never
 * published except by its resident's explicit resend (or `{{unsent}}`), and
 * only that resident can list or act on it. Its notices go into the
 * resident's own history — which residents that share one message slot
 * (#197) share, as they already share the assistant turn the words came
 * from.
 *
 * Durability is outside the conversation. Drafts live in a RecordJournal of
 * typed Chronicle records, which do not follow branch switches: undo,
 * rollback, suppression and branch moves never touch them. A draft written
 * in a turn that is later undone stays usable (the words were genuinely
 * written and held back), and a delivered draft stays delivered. Its
 * originating branch is recorded as provenance only.
 *
 * A delivery attempt is journaled durably BEFORE its request leaves the
 * host, and its outcome after: an attempt with no recorded outcome (a crash
 * mid-send) reads as unknown, never as unsent. A delivered draft carries a
 * historical receipt — confirmed at a time, to a destination, with the
 * connector's message id — not a claim that the message still exists.
 * Nothing here publishes anything: every send is the resident's explicit
 * resend, and nothing replays at boot or on a branch move.
 */

import { randomInt } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import { RecordJournal } from './record-journal.js';
import type { PublishDestination, PublishOutcome } from './mcpl/channel-registry.js';

/** Chronicle record type of the drafts journal. */
export const PROSE_DRAFT_RECORD_TYPE = 'framework/prose-draft';

/** Why words were held instead of sent. */
export type DraftReason =
  /** An explicit send in the same round suppressed the round's plain speech. */
  | 'explicit-send'
  /** The speech had no destination (no route this turn, or a failed envelope). */
  | 'no-destination'
  /** Two conversations competed for an unaddressed reply. */
  | 'ambiguous'
  /** An explicit/hybrid routing prefix was missing, malformed or unresolvable. */
  | 'bounced';

/** Where a draft's words were written. Provenance only: nothing routes by it. */
export interface DraftSource {
  /** Chronicle branch current when the words were held. */
  branch: string;
  /** The resident's logical turn (process-local counter) and the round in it. */
  turn: number;
  round: number;
  /** Position of the segment within its round's speech. */
  segment: number;
}

export interface DraftAttemptOutcome {
  status: PublishOutcome['status'];
  at: number;
  messageId?: string;
  reason?: string;
  detail?: unknown;
}

export interface DraftAttempt {
  attemptId: string;
  at: number;
  destination: PublishDestination;
  /** How the words went out: the drafts tool, or explicit mode's `{{unsent}}`. */
  via: 'resend' | 'unsent-token';
  /** The resident resent knowing an earlier attempt may have been posted. */
  confirmedDuplicate?: true;
  /** Absent until recorded; an attempt without one reads as unknown. */
  outcome?: DraftAttemptOutcome;
}

/**
 * A draft held with words copied from another draft that may already have
 * been posted (`{{unsent}}` re-bounced while that draft was unconfirmed or in
 * flight). The new draft keeps the whole authored text and carries the same
 * duplication risk: it reads `unconfirmed` until a confirmed delivery.
 */
export interface InheritedRisk {
  /** The draft whose words were copied in. */
  draftId: string;
  /** The draft whose attempt is the uncertain one, when the copied draft
   *  itself carried inherited risk (a chain of re-bounces): the evidence is
   *  that original attempt's, never re-invented. */
  sourceDraftId?: string;
  /** That uncertain attempt, when there was one (absent: it was in flight). */
  destination?: PublishDestination;
  at?: number;
  reason: string;
}

export interface Draft {
  id: string;
  agent: string;
  /** The held words, byte for byte. */
  text: string;
  reason: DraftReason;
  /** Words copied in from a draft that may already have been posted. */
  inheritedRisk?: InheritedRisk;
  /** Short context for the resident: the bounce reason, or the competing conversations. */
  note?: string;
  heldAt: number;
  source: DraftSource;
  attempts: DraftAttempt[];
  dismissedAt?: number;
  /** When an in-band notice named this draft. */
  noticedAt?: number;
}

/**
 * - `held`: never attempted, or every attempt definitely failed — resend freely;
 * - `unconfirmed`: some attempt's outcome is unknown (or was never
 *   recorded), and none was confirmed: it may have been posted, so a resend
 *   needs explicit confirmation. A later attempt that fails does not resolve
 *   an earlier one that may have landed — the uncertainty stays;
 * - `delivered`: an attempt was confirmed — its receipt is historical;
 * - `dismissed`: the resident set it aside.
 */
export type DraftState = 'held' | 'unconfirmed' | 'delivered' | 'dismissed';

export function draftState(draft: Draft): DraftState {
  if (draft.attempts.some((a) => a.outcome?.status === 'delivered')) return 'delivered';
  if (draft.dismissedAt !== undefined) return 'dismissed';
  return uncertainAttempt(draft) || draft.inheritedRisk ? 'unconfirmed' : 'held';
}

/** The most recent attempt that may have been posted (unknown or unrecorded
 *  outcome), when no attempt was confirmed. */
export function uncertainAttempt(draft: Draft): DraftAttempt | undefined {
  if (draft.attempts.some((a) => a.outcome?.status === 'delivered')) return undefined;
  for (let i = draft.attempts.length - 1; i >= 0; i--) {
    const attempt = draft.attempts[i]!;
    if (!attempt.outcome || attempt.outcome.status === 'unknown') return attempt;
  }
  return undefined;
}

type DraftEntry =
  | { op: 'held'; draft: Omit<Draft, 'attempts' | 'dismissedAt' | 'noticedAt'> }
  | { op: 'attempt'; agent: string; id: string; attemptId: string; at: number; destination: PublishDestination; via: DraftAttempt['via']; confirmedDuplicate?: true }
  | { op: 'outcome'; agent: string; id: string; attemptId: string; outcome: DraftAttemptOutcome }
  | { op: 'dismissed'; agent: string; id: string; at: number }
  | { op: 'noticed'; agent: string; ids: string[]; at: number };

/** Unambiguous lowercase alphabet for short ids (no i/l/o/0/1). */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export class ProseDraftStore {
  private readonly journal: RecordJournal<DraftEntry>;
  /** agent → draft id → draft, in journal (hold) order. */
  private drafts = new Map<string, Map<string, Draft>>();

  constructor(store: JsStore) {
    this.journal = new RecordJournal<DraftEntry>(store, { type: PROSE_DRAFT_RECORD_TYPE });
    this.reload();
  }

  /** Rebuild the projection from the journal (at open, and to reconcile). */
  reload(): void {
    const { entries } = this.journal.load();
    this.drafts = new Map();
    for (const { entry } of entries) this.reduce(entry);
  }

  private reduce(entry: DraftEntry): void {
    if (entry.op === 'held') {
      this.agentDrafts(entry.draft.agent).set(entry.draft.id, { ...entry.draft, attempts: [] });
      return;
    }
    if (entry.op === 'noticed') {
      for (const id of entry.ids) {
        const draft = this.drafts.get(entry.agent)?.get(id);
        if (draft && draft.noticedAt === undefined) draft.noticedAt = entry.at;
      }
      return;
    }
    const draft = this.drafts.get(entry.agent)?.get(entry.id);
    if (!draft) return;
    if (entry.op === 'dismissed') {
      draft.dismissedAt ??= entry.at;
    } else if (entry.op === 'attempt') {
      draft.attempts.push({
        attemptId: entry.attemptId,
        at: entry.at,
        destination: entry.destination,
        via: entry.via,
        ...(entry.confirmedDuplicate ? { confirmedDuplicate: true as const } : {}),
      });
    } else if (entry.op === 'outcome') {
      const attempt = draft.attempts.find((a) => a.attemptId === entry.attemptId);
      if (attempt) attempt.outcome = entry.outcome;
    }
  }

  /**
   * Journal and apply one entry. A write that fails after reaching the store
   * leaves the journal unreconciled: rebuild from it before rethrowing, so
   * the projection never disagrees with what the journal holds.
   */
  private write(entry: DraftEntry, durable: boolean, afterCommittedState = false): void {
    try {
      this.journal.append(entry, { durable, afterCommittedState });
    } catch (err) {
      if (this.journal.needsReconcile) this.reload();
      throw err;
    }
    this.reduce(entry);
  }

  private agentDrafts(agent: string): Map<string, Draft> {
    let map = this.drafts.get(agent);
    if (!map) {
      map = new Map();
      this.drafts.set(agent, map);
    }
    return map;
  }

  private newId(agent: string): string {
    const existing = this.agentDrafts(agent);
    for (;;) {
      let id = 'd-';
      for (let i = 0; i < 5; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
      if (!existing.has(id)) return id;
    }
  }

  /**
   * Hold words as drafts, in order, each journaled durably before this
   * returns. If the journal refuses a write (after reconciling), the drafts
   * already written stand and the rest are reported as not held: their words
   * remain in the resident's history only.
   */
  hold(
    agent: string,
    segments: Array<{ text: string; source: DraftSource; note?: string; inheritedRisk?: InheritedRisk }>,
    reason: DraftReason,
    note?: string,
  ): { held: Draft[]; notHeld?: { count: number; error: string } } {
    const held: Draft[] = [];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      const segmentNote = segment.note ?? note;
      const draft = {
        id: this.newId(agent),
        agent,
        text: segment.text,
        reason,
        ...(segmentNote ? { note: segmentNote } : {}),
        ...(segment.inheritedRisk ? { inheritedRisk: segment.inheritedRisk } : {}),
        heldAt: Date.now(),
        source: segment.source,
      };
      try {
        this.write({ op: 'held', draft }, true);
      } catch (err) {
        return { held, notHeld: { count: segments.length - i, error: err instanceof Error ? err.message : String(err) } };
      }
      held.push(this.get(agent, draft.id)!);
    }
    return { held };
  }

  get(agent: string, id: string): Draft | undefined {
    return this.drafts.get(agent)?.get(id);
  }

  /** Held and unconfirmed drafts, newest first (journal order, which is
   *  exact even for segments held in the same millisecond). */
  open(agent: string): Draft[] {
    return [...(this.drafts.get(agent)?.values() ?? [])]
      .filter((d) => { const s = draftState(d); return s === 'held' || s === 'unconfirmed'; })
      .reverse();
  }

  /** Open drafts no in-band notice has named yet (a crash before the notice). */
  unnoticed(agent: string): Draft[] {
    return this.open(agent).filter((d) => d.noticedAt === undefined).reverse();
  }

  /**
   * Record that a notice naming these drafts is in the resident's history.
   * The notice is conversation state, buffered until the store syncs, while
   * this record reaches the OS at once: so the store is synced FIRST
   * (afterCommittedState), and a notice that never became durable can't
   * leave a record that suppresses the crash catch-up.
   */
  markNoticed(agent: string, ids: string[]): void {
    if (ids.length === 0) return;
    this.write({ op: 'noticed', agent, ids, at: Date.now() }, true, true);
  }

  dismiss(agent: string, id: string): void {
    this.write({ op: 'dismissed', agent, id, at: Date.now() }, true);
  }

  /**
   * Journal a delivery attempt durably, BEFORE the request leaves the host.
   * Throws (having reconciled) when it cannot be made durable: the caller
   * must then not send.
   */
  beginAttempt(
    agent: string,
    id: string,
    destination: PublishDestination,
    via: DraftAttempt['via'],
    confirmedDuplicate: boolean,
  ): string {
    const attemptId = `a-${Date.now().toString(36)}-${randomInt(36 ** 4).toString(36)}`;
    this.write({
      op: 'attempt', agent, id, attemptId, at: Date.now(), destination, via,
      ...(confirmedDuplicate ? { confirmedDuplicate: true as const } : {}),
    }, true);
    return attemptId;
  }

  /** Journal what an attempt established. */
  recordOutcome(agent: string, id: string, attemptId: string, outcome: PublishOutcome): void {
    this.write({
      op: 'outcome', agent, id, attemptId,
      outcome: {
        status: outcome.status,
        at: outcome.at,
        ...(outcome.messageId ? { messageId: outcome.messageId } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      },
    }, true);
  }

  /**
   * Explicit and hybrid mode's `{{unsent}}`: the most recent bounce, while
   * that draft is still open (held or unconfirmed — the caller must not
   * resend an unconfirmed one without the resident's confirmation).
   * Latest-wins, like the clipboard it replaces: once the latest bounce is
   * delivered or dismissed there is nothing to substitute, even if older
   * bounces are still held (they stay in the collection, by id).
   */
  latestBounce(agent: string): Draft | undefined {
    let latest: Draft | undefined;
    for (const draft of this.drafts.get(agent)?.values() ?? []) {
      if (draft.reason === 'bounced') latest = draft;
    }
    if (!latest) return undefined;
    const state = draftState(latest);
    return state === 'held' || state === 'unconfirmed' ? latest : undefined;
  }
}

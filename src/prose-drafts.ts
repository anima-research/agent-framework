/**
 * Held prose drafts: a resident's plain speech that was not sent.
 *
 * Plain speech is held back for reasons that are right in themselves: an
 * explicit send in the same round suppresses the round's prose (so a "sent
 * it" postscript is not posted twice), a turn may have no destination, and a
 * malformed or unresolvable routing prefix bounces. Before drafts, the held words were
 * kept only as a count (or, in explicit mode, as one in-memory latest-wins
 * clipboard): the law was right, and the penalty was amnesia. A draft keeps
 * the exact words until the resident resends or dismisses them, or the
 * retention below lets it go.
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
 * written and held back), and a delivered draft stays delivered. The
 * notices that name a draft are conversation, so they do follow the branch: a draft counts as
 * named while a message naming it is on the current branch, and one a
 * rollback or branch move has left unnamed is named again.
 *
 * Drafts are kept, not hoarded. Each resident's KEEP_NEWEST newest drafts
 * are always kept; an older one, in any state, is let go at the journal's
 * next checkpoint once nothing has happened to it (held, named, attempted,
 * answered, dismissed) for KEEP_IDLE_MS. The journal checkpoints what it
 * keeps every CHECKPOINT_EVERY entries, so opening it replays only what came
 * after, and a resident whose drafts change rarely keeps its older ones
 * until then. The words stay in the resident's history either way.
 *
 * A delivery attempt is journaled durably BEFORE its request leaves the
 * host, and its outcome after: an attempt with no recorded outcome (a crash
 * mid-send) reads as unknown, never as unsent. A delivered draft carries a
 * historical receipt — confirmed at a time, to a destination, with the
 * connector's message id when it names one — not a claim that the message
 * still exists. A draft is sent only by its resident's explicit resend or
 * an envelope's {{unsent}}; nothing replays at boot or on a branch move.
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
  /** An explicit/hybrid routing prefix was missing, malformed or unresolvable. */
  | 'bounced';

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
  /** How the words went out: the drafts tool, or a `{{unsent}}` envelope (explicit or hybrid). */
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
  /** The held words, byte for byte as a resend publishes them: a run an
   *  explicit send suppressed exactly as written; a bounce or a hold with no
   *  destination, its envelope as routing read it (surrounding whitespace
   *  trimmed). */
  text: string;
  reason: DraftReason;
  /** Words copied in from a draft that may already have been posted. */
  inheritedRisk?: InheritedRisk;
  /** Short context for the resident: the bounce reason, or the competing conversations. */
  note?: string;
  heldAt: number;
  attempts: DraftAttempt[];
  dismissedAt?: number;
  /** The messages whose notices named this draft, by id. It counts as named
   *  while one of them is on the current branch. */
  noticedIn?: string[];
  /** When a notice last named it. */
  noticedAt?: number;
}

/**
 * - `held`: no inherited risk, and never attempted or every attempt
 *   definitely failed — resend freely;
 * - `unconfirmed`: no attempt was confirmed and the draft is not dismissed;
 *   either an attempt's outcome is unknown (or was never recorded), or the
 *   words carry inherited risk regardless of their own attempts. A resend
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
  | { op: 'held'; draft: Omit<Draft, 'attempts' | 'dismissedAt' | 'noticedIn' | 'noticedAt'> }
  | { op: 'attempt'; agent: string; id: string; attemptId: string; at: number; destination: PublishDestination; via: DraftAttempt['via']; confirmedDuplicate?: true }
  | { op: 'outcome'; agent: string; id: string; attemptId: string; outcome: DraftAttemptOutcome }
  | { op: 'dismissed'; agent: string; id: string; at: number }
  /** A notice naming these drafts is in the history as message `messageId`.
   *  (A record without one names nowhere the drafts can be found again, so
   *  they are named once more.) */
  | { op: 'noticed'; agent: string; ids: string[]; at: number; messageId?: string };

/** What a checkpoint keeps: every kept draft, in hold order, and each
 *  resident's latest bounce, which `{{unsent}}` means whatever became of it. */
interface DraftSnapshot {
  v: 1;
  drafts: Draft[];
  latestBounces: Record<string, string>;
}

/** Unambiguous lowercase alphabet for short ids (no i/l/o/0/1). */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/**
 * Characters after `d-` in a draft's id: 31^7, about 2.75 × 10^10 ids, so a
 * mistyped id almost never names a real draft, and an id retention let go is
 * given again only rarely (see newId).
 */
const ID_LENGTH = 7;

/** Each resident's newest drafts, by hold order, that are always kept. */
export const KEEP_NEWEST = 100;
/** How long an older draft is kept after the last thing that happened to it. */
export const KEEP_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** Entries the journal takes between checkpoints. */
export const CHECKPOINT_EVERY = 500;

/** The store's retention, KEEP_NEWEST, KEEP_IDLE_MS and CHECKPOINT_EVERY
 *  unless given (tests give smaller ones). */
export interface DraftRetention {
  keepNewest: number;
  keepIdleMs: number;
  checkpointEvery: number;
}

/** The last time anything happened to a draft: held, named, attempted,
 *  answered or dismissed. */
function lastActivity(draft: Draft): number {
  let last = Math.max(draft.heldAt, draft.noticedAt ?? 0, draft.dismissedAt ?? 0);
  for (const attempt of draft.attempts) last = Math.max(last, attempt.at, attempt.outcome?.at ?? 0);
  return last;
}

export class ProseDraftStore {
  private readonly journal: RecordJournal<DraftEntry, DraftSnapshot>;
  /** agent → draft id → draft, in journal (hold) order. */
  private drafts = new Map<string, Map<string, Draft>>();
  /** agent → the id of its latest bounce, kept or not. */
  private latestBounces = new Map<string, string>();
  private readonly retention: DraftRetention;

  constructor(store: JsStore, retention: Partial<DraftRetention> = {}) {
    this.journal = new RecordJournal<DraftEntry, DraftSnapshot>(store, { type: PROSE_DRAFT_RECORD_TYPE });
    this.retention = {
      keepNewest: retention.keepNewest ?? KEEP_NEWEST,
      keepIdleMs: retention.keepIdleMs ?? KEEP_IDLE_MS,
      checkpointEvery: retention.checkpointEvery ?? CHECKPOINT_EVERY,
    };
    this.reload();
    this.checkpointIfDue();
  }

  /** Rebuild the projection from the journal (at open, and to reconcile):
   *  the latest checkpoint's drafts, then the entries after it. */
  reload(): void {
    const { snapshot, entries } = this.journal.load();
    this.drafts = new Map();
    this.latestBounces = new Map(Object.entries(snapshot?.latestBounces ?? {}));
    for (const draft of snapshot?.drafts ?? []) this.agentDrafts(draft.agent).set(draft.id, draft);
    for (const { entry } of entries) this.reduce(entry);
  }

  /**
   * Write a checkpoint once CHECKPOINT_EVERY entries have been appended since
   * the last one, letting go of the drafts that aren't kept (see the module
   * header). The projection drops them only once the checkpoint is written,
   * so a failed one changes nothing, and the next write tries again.
   */
  private checkpointIfDue(): void {
    const { keepNewest, keepIdleMs, checkpointEvery } = this.retention;
    if (this.journal.entriesSinceCheckpoint < checkpointEvery) return;
    const now = Date.now();
    const kept = new Map<string, Map<string, Draft>>();
    for (const [agent, drafts] of this.drafts) {
      const all = [...drafts.values()];
      const keep = new Map<string, Draft>();
      all.forEach((draft, i) => {
        if (i >= all.length - keepNewest || now - lastActivity(draft) < keepIdleMs) keep.set(draft.id, draft);
      });
      if (keep.size > 0) kept.set(agent, keep);
    }
    const snapshot: DraftSnapshot = {
      v: 1,
      drafts: [...kept.values()].flatMap((m) => [...m.values()]),
      latestBounces: Object.fromEntries(this.latestBounces),
    };
    try {
      this.journal.checkpoint(snapshot);
    } catch (err) {
      console.error('[drafts] checkpoint failed; the next write tries again:', err);
      if (this.journal.needsReconcile) this.reload();
      return;
    }
    this.drafts = kept;
  }

  private reduce(entry: DraftEntry): void {
    if (entry.op === 'held') {
      this.agentDrafts(entry.draft.agent).set(entry.draft.id, { ...entry.draft, attempts: [] });
      if (entry.draft.reason === 'bounced') this.latestBounces.set(entry.draft.agent, entry.draft.id);
      return;
    }
    if (entry.op === 'noticed') {
      if (entry.messageId === undefined) return;
      for (const id of entry.ids) {
        const draft = this.drafts.get(entry.agent)?.get(id);
        if (!draft) continue;
        draft.noticedIn ??= [];
        if (!draft.noticedIn.includes(entry.messageId)) draft.noticedIn.push(entry.messageId);
        draft.noticedAt = Math.max(draft.noticedAt ?? 0, entry.at);
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
   * Journal and apply one entry. A write that fails after the store's append
   * returned leaves the journal unreconciled: rebuild from it before
   * rethrowing, so the projection never disagrees with what the journal
   * holds. An append that fails inside the store can't be read back until
   * the store is reopened: the journal then refuses every write until the
   * next start, which replays that entry, so until then each write throws,
   * no new draft is kept, and the projection lacks that entry.
   */
  private write(entry: DraftEntry, durable: boolean, afterCommittedState = false): void {
    try {
      this.journal.append(entry, { durable, afterCommittedState });
    } catch (err) {
      if (this.journal.needsReconcile) this.reload();
      throw err;
    }
    this.reduce(entry);
    this.checkpointIfDue();
  }

  private agentDrafts(agent: string): Map<string, Draft> {
    let map = this.drafts.get(agent);
    if (!map) {
      map = new Map();
      this.drafts.set(agent, map);
    }
    return map;
  }

  /** A new id, unique among the resident's kept drafts and never its latest
   *  bounce's. One that retention let go can be given again: after N more
   *  of its resident's drafts, a given let-go id has come back with a
   *  probability of about N in 2.75 × 10^10 (ID_LENGTH), and a request naming
   *  it then reaches the newer draft rather than being refused. */
  private newId(agent: string): string {
    const existing = this.agentDrafts(agent);
    const latestBounce = this.latestBounces.get(agent);
    for (;;) {
      let id = 'd-';
      for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
      if (!existing.has(id) && id !== latestBounce) return id;
    }
  }

  /**
   * Hold words as drafts, in order, each journaled durably before this
   * returns. If the journal refuses a write (after reconciling), the drafts
   * already written stand and the rest are reported as not held: their words
   * remain in the resident's history only. A draft whose record reached the
   * store before its write failed (its sync did) is in the reconciled
   * journal, so it is held, and counted so. When the store's append itself
   * threw, the record may still be in its log: the draft is reported as not
   * held, and the journal refuses further writes until a reload, which
   * replays it as held if it is there.
   */
  hold(
    agent: string,
    segments: Array<{ text: string; note?: string; inheritedRisk?: InheritedRisk }>,
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
      };
      try {
        this.write({ op: 'held', draft }, true);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const landed = this.get(agent, draft.id);
        if (landed) {
          console.error(`[drafts] ${agent}: ${landed.id} reached the journal, but its write then failed (${error}); it is held`);
          held.push(landed);
        }
        const count = segments.length - i - (landed ? 1 : 0);
        return { held, ...(count > 0 ? { notHeld: { count, error } } : {}) };
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

  /**
   * Open drafts, newest first, that no notice on the current branch names:
   * none was recorded (a crash before the notice), or a rollback or branch
   * move took away every message that named them. `onBranch` says whether a
   * message, by id, is on the current branch.
   */
  unnoticed(agent: string, onBranch: (messageId: string) => boolean): Draft[] {
    return this.open(agent).filter((d) => !d.noticedIn?.some(onBranch));
  }

  /**
   * Record that message `messageId`, a notice naming these drafts, is in the
   * resident's history. The notice is conversation state, buffered until the
   * store syncs, while this record reaches the OS at once: so the store is
   * synced FIRST (afterCommittedState), and a notice that never became
   * durable can't leave a record that suppresses the crash catch-up.
   */
  markNoticed(agent: string, ids: string[], messageId: string): void {
    if (ids.length === 0) return;
    this.write({ op: 'noticed', agent, ids, at: Date.now(), messageId }, true, true);
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
   * delivered, dismissed or let go there is nothing to substitute, even if
   * older bounces are still held (they stay in the collection, by id).
   */
  latestBounce(agent: string): Draft | undefined {
    const id = this.latestBounces.get(agent);
    const latest = id === undefined ? undefined : this.get(agent, id);
    if (!latest) return undefined;
    const state = draftState(latest);
    return state === 'held' || state === 'unconfirmed' ? latest : undefined;
  }
}

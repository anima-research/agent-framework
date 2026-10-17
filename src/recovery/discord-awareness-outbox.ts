import { existsSync, readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import { RecordJournal, type AppendOptions } from '../record-journal.js';
import { OperatorActionError } from '../operator-log.js';

/**
 * Discord awareness marks: a reaction (💤 by default) that an operator may
 * choose to place on Discord messages a surgery removed from a resident's
 * context, so the people who wrote them can see the resident no longer has
 * them in view.
 *
 * Marks are an explicit publication choice, separate from the surgery itself
 * (`DiscordAwarenessMarks`, default `none`). Once requested, they are
 * one-shot: branch moves and restarts never derive new operations from branch
 * state, and a restart never activates a surgery's marks. A batch a crash
 * left prepared is retired at startup, unsent, and the operator redoes the surgery from its source to
 * choose marks again (see recoverAtStartup). Marks already recorded as
 * requests (an activated batch's, or the one-entry batch of a hide or turn
 * undo) go out with any delivery pass, a start's included. What
 * a restart does finish is an interrupted suppression's body, on its own
 * branch. An operator retracts or cancels explicitly. An imported ledger's
 * batches are kept as history, and the work it had still to do is retired,
 * none of it sent, since nobody chose it (see importLegacy).
 *
 * The ledger is an append-only journal of what was asked and what was
 * answered, never a model of what is on Discord. Each operation is recorded
 * as `requested`, then each attempt as `dispatching` (written before its
 * request can leave), then that attempt's outcome. A request that was
 * dispatched and never answered stays `unknown` for good: a later attempt's
 * answer doesn't change it, receipts count it as unresolved, and a later
 * opposite operation discloses it. An operation's status is its latest
 * answer, so an add whose retry Discord confirmed is confirmed, while its
 * first request is still counted as unresolved. An operation is not sent
 * again after three unconfirmed attempts: refused, or unanswered and so
 * possibly landed, one the previous process left on the wire included. An
 * attempt refused before it left the host doesn't count, so a route that is
 * down keeps its work queued.
 *
 * Operations are keyed by (MCPL server id, channel, message, emoji). The
 * server id is the configured route to a bot, not the bot's identity: if the
 * route is re-pointed at another bot, retained operations act as that bot,
 * and nothing here can detect it.
 *
 * The journal lives in the Chronicle store as typed records (RecordJournal):
 * it survives branch switches, rollbacks, `deleteBranch` and a killed
 * process, and lives and dies with its store. Each append is one record
 * holding a group of journal records that apply together. A record that
 * asserts a branch change (an activation after a switch or redaction, or a
 * batch recorded after an in-place change) is appended only after that
 * state is synced, so it can never outlive it. A write that fails inside the
 * store leaves the journal refusing every read and write until the store is
 * reopened (see load).
 */

export const DEFAULT_DISCORD_AWARENESS_EMOJI = '💤';

/**
 * Bound text that came from elsewhere (a Discord error body, a filesystem
 * error) before it is journaled, logged or returned in a receipt: the journal
 * is kept for the store's life, and a server's error text has no length limit
 * of its own. Head and tail are kept, with the omitted length stated;
 * a cut never splits a surrogate pair.
 */
export function boundDiscordAwarenessText(text: string, max = 500): string {
  if (text.length <= max) return text;
  const tailLength = Math.min(100, Math.floor(max / 4));
  let head = text.slice(0, max - tailLength - 40);
  let tail = text.slice(text.length - tailLength);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return `${head} … [${text.length - head.length - tail.length} chars omitted] … ${tail}`;
}

/**
 * A Discord answer that the reaction can never succeed: the message or
 * channel is gone or inaccessible, the emoji can't be used, or the message
 * takes no more reactions (or blocks this one). Retrying cannot help.
 */
export function isPermanentDiscordReactionFailure(message: string): boolean {
  return /unknown message|unknown channel|unknown emoji|missing access|missing permission|cannot access|maximum number of reactions|reaction was blocked|channel .* not found|message .* not found/i
    .test(message);
}

/**
 * An operator's request the journal won't carry out: an unknown batch or
 * retract request, or one in the wrong state. Nothing was written. Any other
 * error from an operator control is a failure to read or write the journal.
 */
export class DiscordAwarenessRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordAwarenessRefusal';
  }
}

/** AF's own refusal to write a request on a closed connection, as an
 *  imported (pre-journal) ledger recorded it: as text, with no typed
 *  outcome. Live attempts are classified by McplRequestError's outcome. */
const PRE_WRITE_REFUSAL = /^Cannot send request:/;

/** The pre-journal (version 1 and 2) ledger file name, imported once. */
const LEGACY_LEDGER_NAME = 'discord-awareness-outbox.json';

/**
 * Where a pre-journal awareness ledger (the JSON file agent-framework 0.22.x
 * kept under a store) is found, to import once.
 */
export function defaultDiscordAwarenessOutboxPath(storePath: string): string {
  return join(storePath, 'recovery', LEGACY_LEDGER_NAME);
}

export interface DiscordAwarenessRef {
  serverId: string;
  channelId: string;
  messageId: string;
}

/** Which removed messages a publication choice covers. */
export type DiscordAwarenessScope = 'addressed' | 'all';

/**
 * An operator's publication choice for one surgery. `none`, the default,
 * keeps the surgery local. With `refs`, the choice authorizes exactly those
 * refs (as a preview showed them): the surgery marks only the ones it
 * actually removes, and never widens the set. Without `refs`, the scope is
 * evaluated when the surgery applies; that form is for an immediate act whose
 * choice and application are the same moment.
 */
export type DiscordAwarenessMarks =
  | 'none'
  | { scope: DiscordAwarenessScope; refs?: DiscordAwarenessRef[] };

export type DiscordAwarenessAction = 'add' | 'remove';

export interface DiscordSuppressionInterval {
  fromId: string;
  toId: string;
}

/** One surgery's request, as recorded when the surgery prepared it. */
export interface DiscordAwarenessBatchRecord {
  id: string;
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  emoji: string;
  createdAt: number;
  /** `none` for a suppression journal with no marks; `legacy` for imports. */
  scope: 'none' | DiscordAwarenessScope | 'legacy';
  /** The refs this batch requests marks on (authorized ∩ removed). */
  refs: DiscordAwarenessRef[];
  /** Removed addressable messages this batch leaves unmarked. */
  unmarked?: number;
  /** Authorized refs the surgery did not remove. */
  notRemoved?: number;
  /**
   * `explicit` with suppression intervals marks a suppression, whose body is
   * finished by its surgery or, after a crash, by startup's resume of its
   * intervals on its target branch: that branch being active doesn't prove
   * the redactions finished. Only a batch's own surgery activates it; a
   * restart never does (see recoverAtStartup).
   */
  activationPolicy?: 'target-branch' | 'explicit';
  /** Idempotent interval operations used to resume an interrupted suppression. */
  suppressionIntervals?: DiscordSuppressionInterval[];
}

/** A surgery's request, as it prepares a batch. */
export interface DiscordAwarenessPrepareInput {
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  refs: DiscordAwarenessRef[];
  scope: DiscordAwarenessBatchRecord['scope'];
  emoji?: string;
  activationPolicy?: 'target-branch' | 'explicit';
  suppressionIntervals?: DiscordSuppressionInterval[];
  unmarked?: number;
  notRemoved?: number;
}

/**
 * What the journal will do with a batch whose body change has landed:
 * - `queued`: it is active, its requests recorded;
 * - `not-scheduled`: none of its marks will be sent (it was retired, or
 *   never recorded);
 * - `unresolved`: neither could be established. If its activation reached
 *   the store where this process can't read it back, its marks go out from
 *   the next start; otherwise none of them is sent.
 */
export type DiscordAwarenessSettlement =
  /** `error`: the entry was recorded, and the journal's sync after it failed. */
  | { status: 'queued'; queued: number; error?: string }
  | { status: 'not-scheduled'; error: string }
  | { status: 'unresolved'; error: string };

/**
 * Where a batch is in its life, as the journal records it:
 * - `prepared`: recorded before its surgery's body change, which settles it.
 *   One a crash leaves is retired at startup, never activated (see
 *   recoverAtStartup). One an operator cancelled stays prepared, with
 *   `cancelled` set, and is never activated;
 * - `active`: settled: activated by its surgery, or imported so, its
 *   requests in its operations;
 * - `discarded`: retired, none of its marks to be sent: by its surgery (the
 *   surgery never happened, or its activation could not be recorded), at
 *   startup (its surgery was interrupted, or failed and couldn't retire it),
 *   or at import (0.22.x never activated it, unless its suppression's body
 *   may be pending: that one stays prepared until a start on its branch
 *   finishes the body and retires it).
 */
export type DiscordAwarenessBatchStatus = 'prepared' | 'active' | 'discarded';

export interface DiscordAwarenessBatch extends DiscordAwarenessBatchRecord {
  status: DiscordAwarenessBatchStatus;
  /** A suppression whose body is recorded complete (by its activation, or by
   *  a later startup's resume). */
  suppressionComplete?: boolean;
  /** A suppression whose body startup gave up, since its target branch
   *  doesn't exist: its removals apply only there, so they are in effect
   *  nowhere (see recoverAtStartup). */
  suppressionAbandoned?: boolean;
  /** Journal position of the surgery's marks choice (its prepare): the
   *  authorization of the adds its activation requests. */
  authorization?: number;
  /** Journal position of a release a pre-release build of this journal
   *  recorded: the authorization of the requests that release queued. */
  releaseAuthorization?: number;
  cancelled?: { at: number; by?: string };
}

export type DiscordAwarenessOutcome = 'confirmed' | 'failed' | 'not-sent' | 'unknown';

export interface DiscordAwarenessAttempt {
  attempt: number;
  /** One id per request on the wire; operations sharing a dispatch share it. */
  dispatchId?: string;
  dispatchedAt: number;
  /** Absent while the request is on the wire in this process. */
  outcome?: DiscordAwarenessOutcome;
  /** For `failed`: Discord's refusal is final for this request. */
  permanent?: boolean;
  outcomeAt?: number;
  error?: string;
}

export interface DiscordAwarenessOpCause {
  /** `release`: a release a pre-release build of this journal recorded. */
  kind: 'batch' | 'retract' | 'release' | 'import';
  batchId?: string;
  requestId?: string;
}

export type DiscordAwarenessOpStatus =
  | 'requested'
  | 'dispatching'
  | 'confirmed'
  | 'failed'
  | 'unknown'
  | 'cancelled';

export interface DiscordAwarenessOp {
  opId: string;
  key: DiscordAwarenessRef & { emoji: string };
  action: DiscordAwarenessAction;
  cause: DiscordAwarenessOpCause;
  /**
   * Journal position of the act that authorized this request: a surgery's
   * marks choice (its prepare, even when activation comes later), a retract,
   * or a release. Between opposite requests for one reaction, the later
   * authorization wins, whenever each request was created.
   */
  authorization: number;
  requestedAt: number;
  attempts: DiscordAwarenessAttempt[];
  cancelled?: { at: number; reason: 'batch-cancelled' | 'request-cancelled' | 'superseded' | 'imported' };
}

/** One dispatch: the head operation for a reaction key, plus any consecutive
 *  pending operations with the same action that share it. */
export interface DiscordAwarenessDispatch {
  key: DiscordAwarenessRef & { emoji: string };
  action: DiscordAwarenessAction;
  opIds: string[];
}

/** Receipt for cancel(). Nothing is ever removed from Discord by a cancel. */
export interface DiscordAwarenessCancelReceipt {
  /** The batch id or retract request id that was cancelled. */
  target: string;
  kind: 'batch' | 'retract';
  /** Operations of this batch or retract that this call stopped before they
   *  were ever sent (for a batch not yet activated, every mark it would have
   *  requested). A repeated cancel stops none. */
  cancelled: number;
  /** Operations on the wire right now: they may still land. */
  inFlight: number;
  /** Operations whose outcome is unknown: they may have landed. */
  unknown: number;
  /** Operations Discord already confirmed (cancel does not undo them). */
  confirmed: number;
  /** Requests of this batch or retract whose outcome is unresolved (on the
   *  wire or unknown), counted per request sent and including earlier
   *  attempts of operations whose last attempt was answered: any may land. */
  unresolvedAttempts: number;
  /** Imported (pre-journal) attempts on this batch whose outcome the old
   *  ledger does not establish: any may have landed. */
  legacyOutcomesUnrecorded: number;
}

/** Receipt for retract(). */
export interface DiscordAwarenessRetractReceipt {
  requestId: string;
  /** Removals queued: one per selected reaction key, whatever history says. */
  removalsQueued: number;
  /** Add operations on those keys that had not ended (due, on the wire, or
   *  unknown), one per batch that asked for the mark, whose later sends and
   *  retries are now retired. One on the wire still settles before the
   *  removal is sent, and any unresolved one may land or have landed
   *  (keysWithUnresolvedAdds). */
  addsSuperseded: number;
  /** Keys whose earlier add attempts are unresolved (on the wire or unknown):
   *  such an add may land after this removal. */
  keysWithUnresolvedAdds: number;
  /** Unresolved earlier add requests on those keys (one per request sent,
   *  however many batches' operations it carried). */
  unresolvedAddAttempts: number;
  /** Keys whose imported (pre-journal) history leaves attempt outcomes
   *  unrecorded: any of those may have had an effect. */
  keysWithLegacyUncertainty: number;
}

/**
 * What a pre-journal ledger recorded about one batch ref, kept as facts. It
 * is evidence for operators and receipts, never a claim about what is on
 * Discord now, and it never causes a dispatch.
 */
export interface DiscordAwarenessLegacyEvidence {
  batchId: string;
  key: DiscordAwarenessRef & { emoji: string };
  /** Attempts the old ledger counted (it kept only the last one's details). */
  attempts: number;
  lastAction: DiscordAwarenessAction;
  /**
   * The last attempt's outcome, as far as the old writer's fields establish
   * it: it recorded a success by clearing `lastError` and a failure by
   * setting it, and nothing else touched that field. `confirmed`: no error
   * after an attempt. `not-sent`: AF refused before writing the request.
   * `refused`: Discord answered that the message or channel is gone or
   * inaccessible. `unrecorded`: any other error, so the request may have
   * landed.
   */
  lastOutcome: 'confirmed' | 'not-sent' | 'refused' | 'unrecorded';
  /**
   * The old writer's reconciliation state at shutdown (`deliveryStatus`):
   * whether its cached belief about the marker matched what it then wanted.
   * Branch reconciliation rewrote it without any request, so it says
   * nothing about any attempt's outcome.
   */
  oldDeliveryStatus: 'pending' | 'applied' | 'permanent-failure';
  lastError?: string;
  /** What the last error was: AF's refusal before writing a request, a
   *  Discord answer (message/channel gone or inaccessible), or anything else. */
  lastErrorKind?: 'pre-write-refusal' | 'discord-answer' | 'other';
  /** Recorded attempts whose outcome the old ledger does not establish:
   *  every attempt before the last (only the last one's details were kept),
   *  and the last when its outcome is `unrecorded`. */
  outcomesUnrecorded: number;
}

/** A batch an import kept as history whose undelivered work it retired,
 *  none of it sent (see importLegacy). */
export interface DiscordAwarenessImportedUnsent {
  batchId: string;
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  /** Marks agent-framework 0.22.x had still to add, and to remove. */
  adds: number;
  removals: number;
}

/** A batch startup retired, or whose suppression body it gave up (see
 *  recoverAtStartup), with what the operator needs to redo its surgery. */
export interface DiscordAwarenessRetirement {
  batchId: string;
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  /** The marks it would have requested, none of them sent: 0 for a batch
   *  with none, one an operator cancelled, or an imported one, whose
   *  undelivered work its import retired and reported. */
  marks: number;
  /** Whether it is a suppression (it names removal intervals). */
  suppression: boolean;
  /**
   * - `interrupted`: its surgery was interrupted, or failed and couldn't
   *   retire it, and left it prepared;
   * - `branch-gone`: a suppression whose body was pending, whose target
   *   branch doesn't exist, so its removals are in effect nowhere.
   */
  reason: 'interrupted' | 'branch-gone';
  /** An imported ledger's batch: its marks stay as the import left them. */
  imported?: boolean;
}

/** Per-batch view for operators: what was asked and what is known. */
export interface DiscordAwarenessBatchView {
  kind: 'batch';
  id: string;
  status: DiscordAwarenessBatchStatus;
  scope: DiscordAwarenessBatchRecord['scope'];
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  emoji: string;
  createdAt: number;
  refs: number;
  unmarked?: number;
  notRemoved?: number;
  cancelled?: { at: number; by?: string };
  /** Counts over the add operations this batch requested, by status. */
  adds: Record<DiscordAwarenessOpStatus, number>;
  /** Removals requested (by any retract) on this batch's refs, by status. */
  removals: Record<DiscordAwarenessOpStatus, number>;
  /** Requests on this batch's refs whose outcome is unknown or on the wire. */
  unresolvedAttempts: number;
  /** What a pre-journal ledger recorded about this batch's refs, if imported. */
  legacy?: {
    entries: number;
    /** Refs whose last recorded action was an add the old ledger saw applied. */
    lastAddConfirmed: number;
    /** Refs whose last recorded action was a removal it saw applied. */
    lastRemoveConfirmed: number;
    /** Recorded attempts whose outcome the old ledger does not establish. */
    outcomesUnrecorded: number;
  };
}

/** One retract request: the removals it queued and what became of them. */
export interface DiscordAwarenessRetractView {
  kind: 'retract';
  /** The retract's request id (what cancel takes). */
  id: string;
  /** The batch it retracted, or `all`. */
  target: string;
  at: number;
  by?: string;
  cancelled?: { at: number; by?: string };
  removals: Record<DiscordAwarenessOpStatus, number>;
  /** Removal requests whose outcome is unknown or on the wire. */
  unresolvedAttempts: number;
}

export type DiscordAwarenessView = DiscordAwarenessBatchView | DiscordAwarenessRetractView;

/** Extract Discord addressing metadata without reading message content. */
export interface DiscordMessageMetadataCarrier {
  metadata?: Record<string, unknown>;
}

export function extractDiscordAwarenessRefs(
  messages: DiscordMessageMetadataCarrier[],
  forcedServerId?: string,
): DiscordAwarenessRef[] {
  const refs = new Map<string, DiscordAwarenessRef>();
  for (const message of messages) {
    const ref = discordRef(message, forcedServerId);
    if (ref) refs.set(refKey(ref), ref);
  }
  return [...refs.values()];
}

/**
 * A surgery's marks choice as a caller passes it at runtime: `none` (or left
 * out), or `{ scope: 'addressed' | 'all', refs? }` with each ref a Discord
 * address. Anything else is refused, never guessed: a bare scope string (the
 * host/command vocabulary) or a misspelled scope would otherwise skip the
 * scope filter and mark every addressable message. Each entry point that
 * takes a choice in this form checks it with this before it plans or
 * changes anything: the framework's rollback and suppression, and the
 * offline recovery. host/command's undo and hide take the bare scope words
 * instead and refuse any other, and the recovery CLI parses its --marks.
 */
export function checkedDiscordAwarenessMarks(marks: unknown): DiscordAwarenessMarks {
  if (marks === undefined || marks === 'none') return 'none';
  if (marks && typeof marks === 'object' && !Array.isArray(marks)) {
    const { scope, refs } = marks as { scope?: unknown; refs?: unknown };
    const isRef = (ref: unknown) => !!ref && typeof ref === 'object'
      && typeof (ref as Record<string, unknown>).serverId === 'string'
      && typeof (ref as Record<string, unknown>).channelId === 'string'
      && typeof (ref as Record<string, unknown>).messageId === 'string';
    if ((scope === 'addressed' || scope === 'all') && (refs === undefined || (Array.isArray(refs) && refs.every(isRef)))) {
      return marks as DiscordAwarenessMarks;
    }
  }
  throw new OperatorActionError(
    'invalid',
    `marks must be 'none' or { scope: 'addressed' | 'all', refs? } (got ${boundDiscordAwarenessText(JSON.stringify(marks) ?? String(marks), 200)})`,
  );
}

/**
 * Select the refs a publication choice covers among removed messages.
 * `addressed` means the message carried the MCPL `chat:addressed` tag (a
 * mention, a reply to the bot, or a DM, as the server classified it); the
 * same signal the framework uses for loci and wakes. With `marks.refs`, only
 * those refs are eligible as well.
 */
export function selectDiscordAwarenessRefs(
  messages: DiscordMessageMetadataCarrier[],
  marks: DiscordAwarenessMarks,
  forcedServerId?: string,
): { refs: DiscordAwarenessRef[]; addressable: number; unmarked: number; notRemoved: number } {
  const addressable = new Map<string, { ref: DiscordAwarenessRef; addressed: boolean }>();
  for (const message of messages) {
    const ref = discordRef(message, forcedServerId);
    if (!ref) continue;
    const key = refKey(ref);
    const addressed = isAddressed(message);
    const existing = addressable.get(key);
    addressable.set(key, { ref, addressed: addressed || existing?.addressed === true });
  }
  if (marks === 'none') {
    return { refs: [], addressable: addressable.size, unmarked: addressable.size, notRemoved: 0 };
  }
  const authorized = marks.refs ? new Set(marks.refs.map(refKey)) : null;
  const refs: DiscordAwarenessRef[] = [];
  for (const [key, candidate] of addressable) {
    if (marks.scope === 'addressed' && !candidate.addressed) continue;
    if (authorized && !authorized.has(key)) continue;
    refs.push(candidate.ref);
  }
  const notRemoved = authorized
    ? [...authorized].filter((key) => !addressable.has(key)).length
    : 0;
  return { refs, addressable: addressable.size, unmarked: addressable.size - refs.length, notRemoved };
}

function discordRef(message: DiscordMessageMetadataCarrier, forcedServerId?: string): DiscordAwarenessRef | null {
  const metadata = message.metadata ?? {};
  const channelId = typeof metadata.channelId === 'string' ? metadata.channelId : '';
  const messageId = typeof metadata.messageId === 'string' ? metadata.messageId : '';
  const metadataServerId = typeof metadata.serverId === 'string' ? metadata.serverId : '';
  const serverId = forcedServerId ?? metadataServerId;
  if (!channelId || !messageId || !serverId) return null;
  const isDiscord = serverId.toLowerCase().includes('discord') || channelId.startsWith('discord:');
  if (!isDiscord) return null;
  return { serverId, channelId, messageId };
}

function isAddressed(message: DiscordMessageMetadataCarrier): boolean {
  const tags = message.metadata?.tags;
  return Array.isArray(tags) && tags.includes('chat:addressed');
}

// ---------------------------------------------------------------------------
// Journal records
// ---------------------------------------------------------------------------

type JournalRecord =
  | { t: 'batch'; at: number; batch: DiscordAwarenessBatchRecord }
  | { t: 'activated'; at: number; batchId: string }
  /** An imported ledger's `active`: a historical fact about its marks, never
   *  a certificate that a suppression's body completed. */
  | { t: 'legacy-activated'; at: number; batchId: string }
  | { t: 'discarded'; at: number; batchId: string }
  /** A pre-release build of this journal held an imported batch's
   *  undelivered work, or its surgery's batch, for an operator's release:
   *  read as nothing, so the work is never sent, as an import now retires
   *  it, and the batch stays as it was. */
  | {
      t: 'held';
      at: number;
      batchId: string;
      reason: string;
      releaseActions: Array<DiscordAwarenessRef & { emoji: string; action: DiscordAwarenessAction }>;
    }
  /** A pre-release build of this journal released a held batch, a
   *  surgery's or an import's: history, since its requests were recorded
   *  with it. */
  | { t: 'released'; at: number; batchId: string; by?: string }
  | { t: 'cancelled'; at: number; batchId: string; by?: string }
  | {
      t: 'requested';
      at: number;
      opId: string;
      key: DiscordAwarenessRef & { emoji: string };
      action: DiscordAwarenessAction;
      cause: DiscordAwarenessOpCause;
    }
  | { t: 'op-cancelled'; at: number; opId: string; reason: 'batch-cancelled' | 'request-cancelled' | 'superseded' | 'imported' }
  | { t: 'dispatching'; at: number; opId: string; attempt: number; dispatchId?: string }
  | {
      t: 'outcome';
      at: number;
      opId: string;
      attempt: number;
      outcome: DiscordAwarenessOutcome;
      permanent?: boolean;
      error?: string;
    }
  | { t: 'retract'; at: number; requestId: string; target: string; by?: string }
  | { t: 'request-cancelled'; at: number; requestId: string; by?: string }
  | { t: 'suppression-complete'; at: number; batchId: string }
  | { t: 'suppression-abandoned'; at: number; batchId: string }
  | { t: 'legacy-evidence'; at: number; evidence: DiscordAwarenessLegacyEvidence }
  | { t: 'import-complete'; at: number; source: 'v1' | 'v2'; sha256: string };

/**
 * One journal entry (one Chronicle record): records that apply together, in
 * format `v` 1. An entry without `v` was written in the same format, before
 * the field existed. A later format that changes what an existing record
 * means takes another `v`, which this build refuses to read (see load)
 * rather than misread; a new record type needs none, since replay ignores a
 * type it doesn't know.
 */
interface JournalEntryGroup {
  v?: number;
  records: JournalRecord[];
}

/** The entry format this build writes and reads. */
const JOURNAL_FORMAT = 1;

export const DISCORD_AWARENESS_RECORD_TYPE = 'af:discord-awareness';

/** What ends a refusal to read the journal (load) that an entry or the
 *  pre-journal ledger causes: each cause with what ends it, which is the
 *  host operator's to do. */
export const DISCORD_AWARENESS_ENTRY_LIFT =
  'an entry a later build wrote stays unreadable, and stops every start too, until a build that reads its format ' +
  'runs, and a corrupt entry, or a pre-journal ledger that can\'t be read, until it is repaired; each is the host ' +
  'operator\'s to do';

/** What ends a refusal to read the journal (load), whatever its cause, for
 *  a process that may have written to it. */
export const DISCORD_AWARENESS_READ_LIFT =
  'after a write that failed inside the store, a restart, which reopens the store, ends this; ' +
  DISCORD_AWARENESS_ENTRY_LIFT;

interface JournalState {
  batches: Map<string, DiscordAwarenessBatch>;
  /** Operations in request order. */
  ops: Map<string, DiscordAwarenessOp>;
  /** Each reaction key's operations, in request order, and the key's place
   *  among keys in the order each was first requested. An operation never
   *  leaves the history, so this is what keeps a lookup of one key's
   *  operations from reading every operation ever requested (opsForKey). */
  byKey: Map<string, { order: number; ops: DiscordAwarenessOp[] }>;
  /** The keys with an operation whose work hasn't ended (opEnded): the only
   *  keys a dispatch can come from, so a claim reads what is live rather
   *  than what is history (pendingDispatches). */
  liveKeys: Set<string>;
  /** Imported pre-journal evidence, by reaction key. */
  legacy: Map<string, DiscordAwarenessLegacyEvidence[]>;
  /** Retract requests, by request id. */
  retracts: Map<string, RetractRequest>;
  importedSources: Set<string>;
  /** Records applied so far: each record's journal position. */
  position: number;
}

interface RetractRequest {
  requestId: string;
  target: string;
  at: number;
  by?: string;
  cancelled?: { at: number; by?: string };
  /** Journal position of the retract: its removals' authorization. */
  authorization: number;
}

/**
 * The durable awareness-mark ledger: an append-only journal of typed records
 * in the store, and the operations reduced from it. One instance per store is
 * the journal's only writer (RecordJournal's single-writer rule): the running
 * framework, or the offline CLI while the host is stopped.
 */
export class DiscordAwarenessOutbox {
  private readonly journal: RecordJournal<JournalEntryGroup>;
  private readonly legacyPath?: string;
  /** Reduced state; rebuilt from the journal when null. */
  private state: JournalState | null = null;
  /** Operations dispatched by this process and still awaiting an outcome. */
  private readonly inFlight = new Set<string>();
  /** The batches whose undelivered work this process's import retired. */
  private importedUnsent: DiscordAwarenessImportedUnsent[] = [];

  /**
   * @param store the Chronicle store the journal lives in.
   * @param opts.legacyPath a pre-journal JSON ledger to import once, if present.
   */
  constructor(store: JsStore, opts: { legacyPath?: string } = {}) {
    // No checkpoints: the reduced state keeps every request and attempt,
    // which receipts, operations() and authorization order read, so a
    // snapshot of it would copy all of it, and copying it every N entries
    // grows the store quadratically with the marks ever requested. Opening
    // replays every entry, and the checkpoints a pre-release build of this
    // journal wrote are never read: Chronicle never removes a record, so
    // every entry they covered is still there to replay.
    this.journal = new RecordJournal(store, { type: DISCORD_AWARENESS_RECORD_TYPE, checkpoints: false });
    if (opts.legacyPath) this.legacyPath = opts.legacyPath;
  }

  // -- surgery side -----------------------------------------------------------

  /**
   * Record a surgery's request before its branch switch. Returns null when it
   * carries neither marks nor a suppression journal. A prepared batch never
   * delivers: only its surgery's activate() does. If its write fails it
   * throws, saying what the journal may hold (failedPrepare), and the
   * surgery doesn't run.
   */
  prepare(input: DiscordAwarenessPrepareInput): DiscordAwarenessBatch | null {
    const batch = batchRecord(input);
    if (!batch) return null;
    try {
      // Durable before the surgery's switch: if the surgery is interrupted,
      // a start finds the batch, retires it and alerts (recoverAtStartup),
      // and finishes a suppression's removals.
      this.append([{ t: 'batch', at: batch.createdAt, batch }], { durable: true });
    } catch (error) {
      throw new Error(this.failedPrepare(batch, error), { cause: error });
    }
    return { ...structuredClone(batch), status: 'prepared' };
  }

  /**
   * What a prepare whose write failed leaves, for the surgery's error (the
   * surgery then doesn't run): nothing; the batch, retired at once when it is
   * in this process's view; or a batch left prepared, which the next start
   * retires, unsent. A suppression's batch also names removals for its
   * target branch, which its surgery never created: until it's retired, a
   * branch made under that name would have them applied at a start on it,
   * so the ways the framework makes a branch from a chosen name refuse it
   * (pendingSuppressionsFor). After a write that failed inside the store
   * this process can't read the journal, and every name is refused until a
   * restart reopens the store.
   */
  private failedPrepare(batch: DiscordAwarenessBatchRecord, error: unknown): string {
    const detail = `recording awareness batch ${batch.id} failed: ${errorText(error)}`;
    const retired = 'the next start retires it, none of its marks sent';
    const unreadable = '. Until a restart reopens the store, no branch can be made, since the journal can\'t be read';
    if (this.journal.needsReopen) {
      return `${detail}; the batch may be in the store, unseen until the store is reopened, ` +
        `and if so ${retired}${unreadable}`;
    }
    if (!this.journal.needsReconcile) return detail;
    try {
      return this.discard(batch.id) ? `${detail}; it reached the journal and is retired` : detail;
    } catch (retireError) {
      return `${detail}; it reached the journal, and retiring it also failed (${errorText(retireError)}), ` +
        `so ${retired}` + (this.journal.needsReopen ? unreadable
          : batch.suppressionIntervals?.length ? `, and until then a branch named ${batch.targetBranch} is refused` : '');
    }
  }

  /** Whether this process can read the journal: not after a write that
   *  failed inside the store, until the store is reopened (see load). */
  get readable(): boolean {
    return !this.journal.needsReopen;
  }

  /**
   * Marks for a body change already applied on `branch` (an in-place hide, a
   * turn undo): a batch for exactly that branch, recorded and activated in
   * one entry, with what the journal will do. Its record asserts the change
   * before it, so it is written only after that change is synced: a crash can
   * never keep the batch and lose the change, and, being one entry, it never
   * leaves the batch prepared, for a startup to retire. If writing it fails,
   * the journal is read back, so the result follows what it holds: a batch
   * that is not there is `not-scheduled` (nothing was recorded); one that is
   * there is `queued`, since the entry landed whole before a later step
   * failed; and if the journal can't be read back, `unresolved`, since the
   * entry may be there. That includes a write that failed inside the store:
   * its record may be in the store's log, which this process can't read
   * until the store is reopened (see load). Returns null when there is
   * nothing to mark. Never throws.
   */
  settleApplied(
    input: Omit<DiscordAwarenessPrepareInput, 'sourceBranch' | 'targetBranch' | 'activationPolicy' | 'suppressionIntervals'>
      & { branch: string },
  ): { batchId: string; marks: number; settled: DiscordAwarenessSettlement } | null {
    const { branch, ...rest } = input;
    const batch = batchRecord({ ...rest, sourceBranch: branch, targetBranch: branch, activationPolicy: 'explicit' });
    if (!batch) return null;
    const settle = (settled: DiscordAwarenessSettlement) => ({ batchId: batch.id, marks: batch.refs.length, settled });
    let state: JournalState;
    try {
      state = this.load();
    } catch (error) {
      // Nothing is written to a journal that can't be read, and nothing
      // schedules these marks later.
      return settle({
        status: 'not-scheduled',
        error: `the journal could not be read: ${errorText(error)}. Nothing schedules these marks later: the change ` +
          'stands, and a later hide or undo can\'t choose the messages it removed. No hide or undo schedules marks ' +
          `until the journal can be read: ${DISCORD_AWARENESS_READ_LIFT}`,
      });
    }
    const at = Date.now();
    // The choice and its application are one act, later than everything
    // recorded: its adds take the latest authorization.
    const requested = this.requestRecords(
      state,
      batch.refs.map((ref) => ({ ...ref, action: 'add' as const })),
      batch.emoji,
      { kind: 'batch', batchId: batch.id },
      at,
    );
    try {
      this.append(
        [{ t: 'batch', at: batch.createdAt, batch }, { t: 'activated', at, batchId: batch.id }, ...requested],
        { afterCommittedState: true, durable: true },
      );
    } catch (error) {
      const detail = `recording the batch failed: ${errorText(error)}`;
      try {
        const after = this.load();
        if (!after.batches.has(batch.id)) return settle({ status: 'not-scheduled', error: detail });
        const queued = [...after.ops.values()]
          .filter((op) => op.cause.kind === 'batch' && op.cause.batchId === batch.id && !op.cancelled).length;
        // Recorded, so delivered, but not known to be on stable storage.
        return settle({ status: 'queued', queued, error: detail });
      } catch (readError) {
        return settle({ status: 'unresolved', error: `${detail}; reading the journal back also failed: ${errorText(readError)}` });
      }
    }
    return settle({ status: 'queued', queued: liveRequests(requested) });
  }

  /**
   * Activate a prepared batch after its body change landed: one `add` request
   * per ref, durable before this returns. Activation completes the surgery's
   * earlier choice; it is not a new one, so an add for a reaction that a
   * later act (a retract, or another batch's request) already decided is
   * recorded superseded and never sent. Returns how many were queued.
   */
  activate(batchId: string): number {
    const state = this.load();
    const batch = state.batches.get(batchId);
    if (!batch) throw new Error(`Discord awareness batch not found: ${batchId}`);
    if (batch.status === 'active') return 0;
    if (batch.status !== 'prepared') {
      throw new Error(`Discord awareness batch ${batchId} is ${batch.status}, not prepared`);
    }
    if (batch.cancelled) {
      // An operator cancelled it while its surgery was still running.
      throw new Error(`Discord awareness batch ${batchId} was cancelled before activation`);
    }
    const at = Date.now();
    const records: JournalRecord[] = [{ t: 'activated', at, batchId }];
    const requested = this.requestRecords(state, batch.refs.map((ref) => ({ ...ref, action: 'add' as const })), batch.emoji, {
      kind: 'batch',
      batchId,
    }, at, batch.authorization);
    records.push(...requested);
    // The activation asserts the body change just committed (the switch, or
    // the last redaction): sync that first, so a crash can never leave marks
    // active for a change the store lost.
    this.append(records, { afterCommittedState: true, durable: true });
    return liveRequests(requested);
  }

  /**
   * Activate a batch after its body change landed, and if that cannot be
   * recorded, retire it instead, so that what the caller reports is what
   * the journal will do. After a failure the batch is read back:
   * - `queued`: the batch is active (including when the activation landed
   *   but its durability barrier failed);
   * - `not-scheduled`: it is retired, by this call or before it (including
   *   when the retirement landed but its barrier failed); none of its marks
   *   will be sent;
   * - `unresolved`: the journal holds neither, as far as this process can
   *   read it. If the activation reached the store unseen, its marks go out
   *   from the next start; otherwise that start retires the batch, unsent.
   * Never throws.
   */
  settleActivation(batchId: string): DiscordAwarenessSettlement {
    let detail: string;
    try {
      return { status: 'queued', queued: this.activate(batchId) };
    } catch (error) {
      detail = boundDiscordAwarenessText(error instanceof Error ? error.message : String(error));
    }
    try {
      if (this.discard(batchId)) return { status: 'not-scheduled', error: detail };
    } catch (error) {
      detail += `; retiring it also failed: ${boundDiscordAwarenessText(error instanceof Error ? error.message : String(error))}`;
    }
    // Neither call settled it as far as it knows: what the journal holds
    // decides. An activation or a retirement can land before its barrier
    // fails, and discard() declines a batch that is no longer prepared.
    try {
      const state = this.load();
      const current = state.batches.get(batchId);
      if (current?.status === 'active') {
        const queued = [...state.ops.values()]
          .filter((op) => op.cause.kind === 'batch' && op.cause.batchId === batchId && !op.cancelled).length;
        // Recorded, so delivered, but not known to be on stable storage.
        return { status: 'queued', queued, error: detail };
      }
      if (current?.status === 'discarded') return { status: 'not-scheduled', error: detail };
    } catch (error) {
      detail += `; reading the journal back also failed: ${boundDiscordAwarenessText(error instanceof Error ? error.message : String(error))}`;
    }
    return { status: 'unresolved', error: detail };
  }

  /**
   * Retire a batch whose surgery did not complete. Only a prepared batch can
   * be discarded; returns false when nothing was retired.
   */
  discard(batchId: string): boolean {
    const batch = this.load().batches.get(batchId);
    if (!batch || batch.status !== 'prepared') return false;
    // Retiring a batch retires its obligations (marks and any body resume):
    // the branch state its surgery left (a restored source, or a completed
    // body) is synced first, and the record is durable, so a crash can never
    // keep the retirement while losing the state it relies on.
    this.append([{ t: 'discarded', at: Date.now(), batchId }], { afterCommittedState: true, durable: true });
    return true;
  }

  /** A batch's status as the journal holds it now, or undefined when it
   *  holds no such batch. Throws when the journal can't be read. A write can
   *  land before its durable barrier fails, so after a failed discard this
   *  says whether the retirement is in the journal. */
  batchStatus(batchId: string): DiscordAwarenessBatch['status'] | undefined {
    return this.load().batches.get(batchId)?.status;
  }

  /**
   * The suppressions whose body may still be applied on `branch`: batches
   * whose target is exactly that branch, not retired, whose body was never
   * recorded complete or given up (isPendingSuppression), whether prepared
   * or active, cancelled or not. Activation records a surgery's body complete, so
   * these are a surgery's leftovers (prepared), an imported ledger's
   * batches, since the old ledger could record activation before the
   * redactions were synced, and a batch a pre-release build released without
   * finishing its body. A start
   * on that branch finishes their removals (the framework's
   * resumePreparedDiscordSuppressions). The same set claims the name: a
   * branch made under it by anything else would have those removals applied
   * at a start on it, so rollback, suppression and the API's `branch.create`
   * refuse such a name (checkDiscordAwarenessBranchName), as does the
   * offline recovery, and the API's `branch.switch` won't serve it. A turn
   * undo's branch, whose generated name carries the time it was made, isn't
   * checked.
   * Branch ancestry is never consulted. Reads the journal, so it throws when
   * the journal can't be read.
   */
  pendingSuppressionsFor(branch: string): DiscordAwarenessBatch[] {
    return [...this.load().batches.values()]
      .filter((batch) => isPendingSuppression(batch) && batch.targetBranch === branch)
      .map((batch) => structuredClone(batch));
  }

  /**
   * Record a suppression's body complete, once a start on its branch has
   * finished its removals. A leftover (isSurgeryLeftover: still prepared,
   * its surgery interrupted, or an import's that agent-framework 0.22.x
   * never activated) is retired in the same entry, none of its marks sent: a
   * restart never activates a surgery's marks. An import's active batch
   * keeps its marks as they are. Returns whether it was retired.
   */
  completeSuppression(batchId: string): { retired: boolean } {
    const batch = this.load().batches.get(batchId);
    const retired = !!batch && isSurgeryLeftover(batch);
    const at = Date.now();
    const records: JournalRecord[] = [{ t: 'suppression-complete', at, batchId }];
    if (retired) records.push({ t: 'discarded', at, batchId });
    // Certifies the redactions just made: only after they are synced.
    this.append(records, { afterCommittedState: true, durable: true });
    return { retired };
  }

  /**
   * Startup reconciliation, run once before any delivery. It derives nothing
   * from branch ancestry, and it activates nothing:
   * - an attempt left `dispatching` by a previous process is recorded
   *   `unknown` (it may have reached Discord). Like any unanswered attempt,
   *   it counts toward the bound: `givenUp` is how many operations it
   *   brought there, which won't be sent again;
   * - a leftover (isSurgeryLeftover: a prepared batch, which an interrupted
   *   surgery left, or a failed one that couldn't retire it) is retired,
   *   none of its marks sent: the operator redoes the surgery from its source
   *   to choose marks again. While its body is pending, a suppression whose target
   *   branch exists is kept instead: a start on that branch finishes its
   *   removals and then retires it (completeSuppression);
   * - a suppression whose body is pending and whose target branch doesn't
   *   exist (`branchExists`, when given) is given up, since its removals
   *   apply only on that branch: either its surgery ended before it created
   *   it, or it was deleted (the API's `branch.delete`). A leftover is
   *   retired; an imported ledger's active batch keeps its marks as they are
   *   and gives up only its body (`suppressionAbandoned`).
   * Each is reported in `retired`, with why, and each suppression whose
   * body stays pending for a branch that exists, a leftover's or an
   * import's, in `pending`. What it records is written only after the
   * store's state is synced, since giving up a body relies on its branch
   * being gone. `imported` names the batches whose undelivered work this
   * process's import of a pre-journal ledger retired, none of it sent.
   */
  recoverAtStartup(
    branchExists?: (name: string) => boolean,
  ): {
    retired: DiscordAwarenessRetirement[];
    /** Suppressions whose removals stay pending for a branch that exists:
     *  a start on that branch finishes them. */
    pending: Array<{ batchId: string; agentName: string; targetBranch: string }>;
    unknownAttempts: number;
    givenUp: number;
    imported: DiscordAwarenessImportedUnsent[];
  } {
    const state = this.load();
    const at = Date.now();
    const records: JournalRecord[] = [];
    let unknownAttempts = 0;
    const orphaned = new Set<string>();
    for (const op of state.ops.values()) {
      for (const attempt of op.attempts) {
        if (attempt.outcome !== undefined) continue;
        orphaned.add(op.opId);
        records.push({
          t: 'outcome',
          at,
          opId: op.opId,
          attempt: attempt.attempt,
          outcome: 'unknown',
          error: 'the previous process ended before an outcome was recorded',
        });
        unknownAttempts++;
      }
    }
    const retired: DiscordAwarenessRetirement[] = [];
    const kept: Array<{ batchId: string; agentName: string; targetBranch: string }> = [];
    for (const batch of state.batches.values()) {
      if (batch.status === 'discarded') continue;
      const pending = isPendingSuppression(batch);
      const gone = pending && !!branchExists && !branchExists(batch.targetBranch);
      const leftover = isSurgeryLeftover(batch);
      if (leftover) {
        // A body still to finish on a branch that exists waits for a start on it.
        if (pending && !gone) {
          kept.push({ batchId: batch.id, agentName: batch.agentName, targetBranch: batch.targetBranch });
          continue;
        }
        records.push({ t: 'discarded', at, batchId: batch.id });
      } else {
        // An imported ledger's active batch: its marks stay as they were,
        // and only a body that can't be applied is given up.
        if (!gone) {
          if (pending) kept.push({ batchId: batch.id, agentName: batch.agentName, targetBranch: batch.targetBranch });
          continue;
        }
        records.push({ t: 'suppression-abandoned', at, batchId: batch.id });
      }
      retired.push({
        batchId: batch.id,
        agentName: batch.agentName,
        sourceBranch: batch.sourceBranch,
        targetBranch: batch.targetBranch,
        // An import's marks were reported as its import retired them.
        marks: leftover && !batch.cancelled && batch.scope !== 'legacy' ? batch.refs.length : 0,
        suppression: !!batch.suppressionIntervals?.length,
        reason: gone ? 'branch-gone' : 'interrupted',
        ...(batch.scope === 'legacy' ? { imported: true } : {}),
      });
    }
    // A body given up relies on its branch's deletion, which may be unsynced
    // in a caller-supplied store already open: a crash could keep the
    // retirement and lose the deletion. The store is synced first, as before
    // every retirement, and a failed sync records nothing.
    if (records.length > 0) this.append(records, { afterCommittedState: true, durable: true });
    const after = this.load();
    const givenUp = [...orphaned].filter((opId) => {
      const op = after.ops.get(opId);
      return !!op && !op.cancelled && unconfirmedAttempts(op) >= MAX_UNCONFIRMED_ATTEMPTS;
    }).length;
    return { retired, pending: kept, unknownAttempts, givenUp, imported: [...this.importedUnsent] };
  }

  // -- operator controls ------------------------------------------------------

  /**
   * Stop all future dispatch and retry of a batch's requests: unsent ones,
   * ones on the wire (their outcome is still recorded when it comes), and
   * ones whose outcome is unknown. Nothing is ever removed from Discord by a
   * cancel: the receipt
   * reports what may already have landed, and retract removes it.
   */
  cancel(target: string, by?: string): DiscordAwarenessCancelReceipt {
    const state = this.load();
    if (state.retracts.has(target)) return this.cancelRetract(state, target, by);
    const batchId = target;
    const batch = state.batches.get(batchId);
    if (!batch) throw new DiscordAwarenessRefusal(`Discord awareness batch or retract request not found: ${target}`);
    const receipt: DiscordAwarenessCancelReceipt = {
      target: batchId,
      kind: 'batch',
      // A prepared batch (its surgery still running, or its bookkeeping
      // unresolved) has no requests yet: every one of its marks is stopped.
      cancelled: batch.status === 'prepared' && !batch.cancelled ? batch.refs.length : 0,
      inFlight: 0,
      unknown: 0,
      confirmed: 0,
      // Every request the batch itself made: its adds, and what a release a
      // pre-release build recorded for it queued.
      unresolvedAttempts: unresolvedDispatches(
        [...state.ops.values()].filter((op) => op.cause.batchId === batchId),
        (op, attempt) => this.attemptUnresolved(op, attempt),
      ),
      legacyOutcomesUnrecorded: [...state.legacy.values()].flat()
        .filter((evidence) => evidence.batchId === batchId)
        .reduce((sum, evidence) => sum + evidence.outcomesUnrecorded, 0),
    };
    const at = Date.now();
    const records: JournalRecord[] = [{ t: 'cancelled', at, batchId, ...(by ? { by } : {}) }];
    const ops = [...state.ops.values()].filter((op) => op.cause.batchId === batchId);
    records.push(...this.stopRequests(ops, receipt, at, 'batch-cancelled', !!batch.cancelled));
    // A repeated cancel writes nothing; its receipt is still today's history.
    if (!batch.cancelled) this.append(records, { durable: true });
    return receipt;
  }

  /**
   * Count what history says about these requests into a cancel receipt, and
   * return the records that stop the ones still able to go out (none when
   * the group was already cancelled). History is counted whatever each
   * request's cancel state: an attempt on the wire or unanswered may land
   * after any cancel, and a confirmation is a fact about Discord.
   */
  private stopRequests(
    ops: DiscordAwarenessOp[],
    receipt: DiscordAwarenessCancelReceipt,
    at: number,
    reason: 'batch-cancelled' | 'request-cancelled',
    alreadyCancelled: boolean,
  ): JournalRecord[] {
    const records: JournalRecord[] = [];
    for (const op of ops) {
      const last = op.attempts.at(-1);
      if (last?.outcome === 'confirmed') {
        receipt.confirmed++;
        continue;
      }
      if (last && last.outcome === undefined) {
        if (this.inFlight.has(op.opId)) receipt.inFlight++;
        else receipt.unknown++;
      } else if (last?.outcome === 'unknown') {
        receipt.unknown++;
      }
      if (alreadyCancelled || op.cancelled) continue;
      const status = this.opStatus(op);
      if (status !== 'requested' && status !== 'dispatching' && status !== 'unknown') continue;
      if (status === 'requested') receipt.cancelled++;
      records.push({ t: 'op-cancelled', at, opId: op.opId, reason });
    }
    return records;
  }

  /** Stop a retract's removals that are still due; nothing sent is undone. */
  private cancelRetract(state: JournalState, requestId: string, by?: string): DiscordAwarenessCancelReceipt {
    const retract = state.retracts.get(requestId)!;
    const ops = [...state.ops.values()].filter((op) => op.cause.requestId === requestId);
    const receipt: DiscordAwarenessCancelReceipt = {
      target: requestId,
      kind: 'retract',
      cancelled: 0,
      inFlight: 0,
      unknown: 0,
      confirmed: 0,
      unresolvedAttempts: unresolvedDispatches(ops, (op, attempt) => this.attemptUnresolved(op, attempt)),
      legacyOutcomesUnrecorded: 0,
    };
    const at = Date.now();
    const records: JournalRecord[] = [{ t: 'request-cancelled', at, requestId, ...(by ? { by } : {}) }];
    records.push(...this.stopRequests(ops, receipt, at, 'request-cancelled', !!retract.cancelled));
    if (!retract.cancelled) this.append(records, { durable: true });
    return receipt;
  }

  /**
   * Remove this bot's mark (through the configured route) from a batch's refs,
   * or (`all`) from every key of every batch not retired, whether prepared
   * or active, every key an add was requested for, and every key an
   * imported ledger recorded. The last two are the direct record of a mark
   * that may be on Discord. In every state this journal or agent-framework
   * 0.22.x writes, each of their keys is also a key of a batch not retired:
   * an add is requested only with its batch's activation, only a prepared
   * batch is retired, and 0.22.x attempted only an active batch's refs. They
   * are kept so that `all` doesn't rest on those rules. A reaction is one
   * per (route, message, emoji), whichever batches asked for it, so this
   * acts across batches. A removal is queued for every selected key, whatever history
   * says: history can't establish what is on Discord now, and removing an
   * absent reaction does nothing. It is the latest authorization for those
   * keys: adds not yet ended are superseded, and adds an earlier choice
   * requests later (a prepared batch's activation) are recorded superseded.
   * The receipt reports history only: earlier add requests whose outcome is
   * unresolved, and imported history that leaves outcomes unrecorded, any
   * of which may land or have landed. An earlier removal's unknown outcome
   * isn't disclosed: it can't bring a mark back, and this removal goes out
   * anyway.
   */
  retract(target: string | 'all', by?: string): DiscordAwarenessRetractReceipt {
    const state = this.load();
    let candidateKeys: Array<DiscordAwarenessRef & { emoji: string }>;
    if (target === 'all') {
      candidateKeys = uniqueKeys([
        ...[...state.batches.values()]
          .filter((batch) => batch.status !== 'discarded')
          .flatMap((batch) => batch.refs.map((ref) => ({ ...ref, emoji: batch.emoji }))),
        ...[...state.ops.values()].filter((op) => op.action === 'add').map((op) => op.key),
        ...[...state.legacy.values()].flat().map((evidence) => evidence.key),
      ]);
    } else {
      const batch = state.batches.get(target);
      if (!batch) throw new DiscordAwarenessRefusal(`Discord awareness batch not found: ${target}`);
      candidateKeys = uniqueKeys(batch.refs.map((ref) => ({ ...ref, emoji: batch.emoji })));
    }
    const requestId = randomUUID();
    const at = Date.now();
    const receipt: DiscordAwarenessRetractReceipt = {
      requestId,
      removalsQueued: 0,
      addsSuperseded: 0,
      keysWithUnresolvedAdds: 0,
      unresolvedAddAttempts: 0,
      keysWithLegacyUncertainty: 0,
    };
    const records: JournalRecord[] = [{ t: 'retract', at, requestId, target, ...(by ? { by } : {}) }];
    const toRemove: Array<DiscordAwarenessRef & { emoji: string; action: DiscordAwarenessAction }> = [];
    for (const key of candidateKeys) {
      const adds = this.opsForKey(state, key).filter((op) => op.action === 'add');
      const unresolved = unresolvedDispatches(adds, (op, attempt) => this.attemptUnresolved(op, attempt));
      if (unresolved > 0) {
        receipt.keysWithUnresolvedAdds++;
        receipt.unresolvedAddAttempts += unresolved;
      }
      if ((state.legacy.get(markKey(key)) ?? []).some((evidence) => evidence.outcomesUnrecorded > 0)) {
        receipt.keysWithLegacyUncertainty++;
      }
      toRemove.push({ ...key, action: 'remove' });
    }
    const requested = this.requestRecords(state, toRemove, undefined, { kind: 'retract', requestId }, at);
    receipt.addsSuperseded = requested.filter((record) => record.t === 'op-cancelled').length;
    receipt.removalsQueued = requested.filter((record) => record.t === 'requested').length;
    records.push(...requested);
    this.append(records, { durable: true });
    return receipt;
  }

  // -- delivery ---------------------------------------------------------------

  /**
   * The next dispatch for each reaction key that has work and nothing on the
   * wire. A key's operations go out in request order; consecutive requested
   * operations with the same action share one dispatch. An `unknown`
   * operation is retried only while it is still the newest live operation
   * for its key. No operation is sent again once three of its attempts
   * went unconfirmed (Discord refused it, or no answer came); an attempt
   * refused before it left the host doesn't count.
   */
  pendingDispatches(serverId?: string): DiscordAwarenessDispatch[] {
    const state = this.load();
    const dispatches: Array<DiscordAwarenessDispatch & { order: number; keyOrder: number }> = [];
    // Only a key with work that hasn't ended can have a dispatch due.
    for (const key of state.liveKeys) {
      const { order: keyOrder, ops } = state.byKey.get(key)!;
      if (serverId !== undefined && ops[0]!.key.serverId !== serverId) continue;
      const head = this.headDispatch(ops);
      if (head) dispatches.push({ ...head, keyOrder });
    }
    // In request order; operations requested together go in the order their
    // keys were first requested.
    return dispatches
      .sort((a, b) => a.order - b.order || a.keyOrder - b.keyOrder)
      .map(({ order: _order, keyOrder: _keyOrder, ...dispatch }) => dispatch);
  }

  /**
   * Choose a server's next due dispatch and write it ahead, in one step:
   * eligibility is computed from the journal as it is now, so a cancel or
   * retract made while an earlier request was on the wire is never
   * overridden by an older list. `skip` excludes dispatches already tried
   * in this pass. Returns null when nothing is due.
   */
  claimDispatch(
    serverId: string,
    skip: (dispatch: DiscordAwarenessDispatch) => boolean = () => false,
  ): { dispatch: DiscordAwarenessDispatch; attempts: Array<{ opId: string; attempt: number }> } | null {
    for (const dispatch of this.pendingDispatches(serverId)) {
      if (skip(dispatch)) continue;
      const attempts = this.recordDispatching(dispatch);
      if (attempts.length > 0) return { dispatch, attempts };
    }
    return null;
  }

  /**
   * Write-ahead: record that a dispatch is about to leave the host. A
   * dispatch computed earlier is narrowed to the operations still due for its
   * key now; when none remain, nothing is written and no attempts are
   * returned (do not send).
   */
  recordDispatching(dispatch: DiscordAwarenessDispatch): Array<{ opId: string; attempt: number }> {
    const state = this.load();
    const current = this.headDispatch(this.opsForKey(state, dispatch.key));
    if (!current || current.action !== dispatch.action) return [];
    const opIds = dispatch.opIds.filter((opId) => current.opIds.includes(opId));
    if (opIds.length === 0) return [];
    const at = Date.now();
    const dispatchId = randomUUID();
    const attempts = opIds.map((opId) => ({ opId, attempt: state.ops.get(opId)!.attempts.length + 1 }));
    this.append(
      attempts.map(({ opId, attempt }) => ({ t: 'dispatching' as const, at, opId, attempt, dispatchId })),
      { durable: true },
    );
    for (const { opId } of attempts) this.inFlight.add(opId);
    return attempts;
  }

  /** The due dispatch for one key's operations (in request order), if any. */
  private headDispatch(ops: DiscordAwarenessOp[]): (DiscordAwarenessDispatch & { order: number }) | null {
    // One request per reaction key on the wire at a time from this process,
    // including a cancelled one still awaiting its outcome: opposite actions
    // must not overtake each other. An attempt a previous process left is
    // recorded unknown at the start, and holds nothing: a retract's receipt
    // says what may still land.
    if (ops.some((op) => op.attempts.length > 0 && op.attempts.at(-1)!.outcome === undefined
      && this.inFlight.has(op.opId))) return null;
    const live = ops.filter((op) => !op.cancelled);
    let head: DiscordAwarenessOp | undefined;
    for (let index = 0; index < live.length; index++) {
      const op = live[index];
      const status = this.opStatus(op);
      if (status === 'requested') { head = op; break; }
      // An unanswered request is sent again only while its operation is the
      // newest live one for its key, and within the bound.
      if (status === 'unknown' && index === live.length - 1
        && unconfirmedAttempts(op) < MAX_UNCONFIRMED_ATTEMPTS) { head = op; break; }
    }
    if (!head) return null;
    const opIds = [head.opId];
    for (let index = live.indexOf(head) + 1; index < live.length; index++) {
      const next = live[index];
      if (next.action !== head.action || this.opStatus(next) !== 'requested') break;
      opIds.push(next.opId);
    }
    return { key: { ...head.key }, action: head.action, opIds, order: head.requestedAt };
  }

  /**
   * Record the outcome of a dispatch's attempts. Returns how many of its
   * operations this outcome ended without a confirmation: refused for good,
   * or at their third unconfirmed attempt (Discord refused it, or no answer
   * came), so they will not be sent again.
   */
  recordOutcome(
    attempts: Array<{ opId: string; attempt: number }>,
    outcome: DiscordAwarenessOutcome,
    detail: { permanent?: boolean; error?: string } = {},
  ): number {
    const at = Date.now();
    const error = detail.error !== undefined ? boundDiscordAwarenessText(detail.error) : undefined;
    try {
      this.append(attempts.map(({ opId, attempt }) => ({
        t: 'outcome' as const,
        at,
        opId,
        attempt,
        outcome,
        ...(outcome === 'failed' && detail.permanent ? { permanent: true } : {}),
        ...(error !== undefined ? { error } : {}),
      })));
    } finally {
      for (const { opId } of attempts) this.inFlight.delete(opId);
    }
    if (outcome !== 'failed' && outcome !== 'unknown') return 0;
    const state = this.load();
    let ended = 0;
    for (const { opId } of attempts) {
      const op = state.ops.get(opId);
      if (!op || op.cancelled) continue;
      if ((outcome === 'failed' && detail.permanent) || unconfirmedAttempts(op) >= MAX_UNCONFIRMED_ATTEMPTS) ended++;
    }
    return ended;
  }

  // -- views ------------------------------------------------------------------

  batches(): DiscordAwarenessBatch[] {
    return [...this.load().batches.values()].map((batch) => structuredClone(batch));
  }

  operations(): DiscordAwarenessOp[] {
    const state = this.load();
    return [...state.ops.values()].map((op) => structuredClone(op));
  }

  /** Status of an operation as this process can know it. */
  operationStatus(op: DiscordAwarenessOp): DiscordAwarenessOpStatus {
    return this.opStatus(op);
  }

  view(): DiscordAwarenessView[] {
    const state = this.load();
    const views: DiscordAwarenessView[] = [];
    for (const batch of state.batches.values()) {
      if (batch.status === 'discarded') continue;
      const keys = new Set(batch.refs.map((ref) => markKey({ ...ref, emoji: batch.emoji })));
      const adds = emptyCounts();
      const removals = emptyCounts();
      const onKeys: DiscordAwarenessOp[] = [];
      for (const key of keys) {
        for (const op of state.byKey.get(key)?.ops ?? []) {
          onKeys.push(op);
          if (op.action === 'add' && op.cause.batchId === batch.id) adds[this.opStatus(op)]++;
          if (op.action === 'remove') removals[this.opStatus(op)]++;
        }
      }
      const unresolvedAttempts = unresolvedDispatches(onKeys, (op, attempt) => this.attemptUnresolved(op, attempt));
      const evidence = [...state.legacy.values()].flat().filter((entry) => entry.batchId === batch.id);
      views.push({
        kind: 'batch',
        id: batch.id,
        status: batch.status,
        scope: batch.scope,
        agentName: batch.agentName,
        sourceBranch: batch.sourceBranch,
        targetBranch: batch.targetBranch,
        emoji: batch.emoji,
        createdAt: batch.createdAt,
        refs: batch.refs.length,
        ...(batch.unmarked !== undefined ? { unmarked: batch.unmarked } : {}),
        ...(batch.notRemoved !== undefined ? { notRemoved: batch.notRemoved } : {}),
        ...(batch.cancelled ? { cancelled: batch.cancelled } : {}),
        adds,
        removals,
        unresolvedAttempts,
        ...(evidence.length > 0
          ? {
              legacy: {
                entries: evidence.length,
                lastAddConfirmed: evidence.filter((entry) => entry.lastAction === 'add' && entry.lastOutcome === 'confirmed').length,
                lastRemoveConfirmed: evidence.filter((entry) => entry.lastAction === 'remove' && entry.lastOutcome === 'confirmed').length,
                outcomesUnrecorded: evidence.reduce((sum, entry) => sum + entry.outcomesUnrecorded, 0),
              },
            }
          : {}),
      });
    }
    for (const retract of state.retracts.values()) {
      const ops = [...state.ops.values()].filter((op) => op.cause.requestId === retract.requestId);
      const removals = emptyCounts();
      for (const op of ops) removals[this.opStatus(op)]++;
      views.push({
        kind: 'retract',
        id: retract.requestId,
        target: retract.target,
        at: retract.at,
        ...(retract.by ? { by: retract.by } : {}),
        ...(retract.cancelled ? { cancelled: retract.cancelled } : {}),
        removals,
        unresolvedAttempts: unresolvedDispatches(ops, (op, attempt) => this.attemptUnresolved(op, attempt)),
      });
    }
    return views;
  }

  // -- internals --------------------------------------------------------------

  /**
   * What became of an operation, latest answer first. What Discord may have
   * comes before whether it will be sent again: a confirmation is a fact
   * about Discord, and a request on the wire or never answered may land or
   * have landed whatever was decided after it was sent (a cancel, or a later
   * opposite act, stops what would be sent next, not a request already
   * sent). Then: cancelled, refused for good (permanently, or after the
   * bound on unconfirmed attempts), or due.
   */
  private opStatus(op: DiscordAwarenessOp): DiscordAwarenessOpStatus {
    const last = op.attempts.at(-1);
    if (last?.outcome === 'confirmed') return 'confirmed';
    if (last && last.outcome === undefined) return this.inFlight.has(op.opId) ? 'dispatching' : 'unknown';
    if (last?.outcome === 'unknown') return 'unknown';
    if (op.cancelled) return 'cancelled';
    if (!last || last.outcome === 'not-sent') return 'requested';
    return last.permanent || unconfirmedAttempts(op) >= MAX_UNCONFIRMED_ATTEMPTS ? 'failed' : 'requested';
  }

  /**
   * An attempt that may have reached Discord without an answer: `unknown`,
   * or still without an outcome (on the wire in this process, or left by a
   * previous process before recoverAtStartup recorded it unknown).
   */
  private attemptUnresolved(_op: DiscordAwarenessOp, attempt: DiscordAwarenessAttempt): boolean {
    return attempt.outcome === 'unknown' || attempt.outcome === undefined;
  }

  private opsForKey(state: JournalState, key: DiscordAwarenessRef & { emoji: string }): DiscordAwarenessOp[] {
    return [...(state.byKey.get(markKey(key))?.ops ?? [])];
  }

  /**
   * Records for new requests, ordered by authorization: between opposite
   * requests for one key, the later authorization wins, whenever each
   * request was created. `authorization` is the journal position of the act
   * the requests carry out (a prepared batch's choice, when its activation
   * comes later); left out, they are a new act, later than everything
   * recorded (a retract, a release).
   * - Each older-authorized opposite request that has not ended (due, on
   *   the wire, or unknown) has its future retries retired. Its attempts
   *   stay as history (an unresolved one is still disclosed), and a request
   *   on the wire still settles before anything else for that key is sent.
   * - A request with an opposite request authorized after it, in any state,
   *   even cancelled, is recorded superseded and never sent: cancelling the
   *   later act stops it without reviving what it decided against.
   */
  private requestRecords(
    state: JournalState,
    requests: Array<DiscordAwarenessRef & { action: DiscordAwarenessAction; emoji?: string }>,
    emoji: string | undefined,
    cause: DiscordAwarenessOpCause,
    at: number,
    authorization: number = Number.POSITIVE_INFINITY,
  ): JournalRecord[] {
    const records: JournalRecord[] = [];
    const superseded = new Set<string>();
    for (const request of requests) {
      const key = {
        serverId: request.serverId,
        channelId: request.channelId,
        messageId: request.messageId,
        emoji: request.emoji ?? emoji ?? DEFAULT_DISCORD_AWARENESS_EMOJI,
      };
      const opposite = this.opsForKey(state, key).filter((op) => op.action !== request.action);
      const opId = randomUUID();
      records.push({ t: 'requested', at, opId, key, action: request.action, cause });
      if (opposite.some((op) => op.authorization > authorization)) {
        records.push({ t: 'op-cancelled', at, opId, reason: 'superseded' });
        continue;
      }
      for (const op of opposite) {
        if (superseded.has(op.opId) || op.cancelled || op.authorization >= authorization) continue;
        const status = this.opStatus(op);
        if (status !== 'requested' && status !== 'dispatching' && status !== 'unknown') continue;
        records.push({ t: 'op-cancelled', at, opId: op.opId, reason: 'superseded' });
        superseded.add(op.opId);
      }
    }
    return records;
  }

  /**
   * The reduced state, rebuilt from the journal when there is none yet or an
   * earlier write left the journal unreconciled (RecordJournal then requires
   * a reload before writing again): every entry is replayed, from the first
   * (see the constructor). An entry in a format this build doesn't know is
   * refused, rather than misread (see JournalEntryGroup). The first load
   * also imports a pre-journal ledger, once.
   *
   * After an append that threw inside the store, its record may be in the
   * store's log where no load in this process can see it (RecordJournal's
   * needsReopen), so nothing decided here could be trusted: every read and
   * write refuses until the store is reopened, as at the next start, which
   * reads that record with the rest.
   */
  private load(): JournalState {
    if (this.journal.needsReopen) {
      throw new Error(
        'The Discord awareness journal can\'t be read in this process: an earlier write failed inside the store, ' +
          'and its record may be there unseen. Nothing is read or written until the store is reopened, as at the next start',
      );
    }
    if (this.state && !this.journal.needsReconcile) return this.state;
    const state = emptyState();
    for (const { id, entry } of this.journal.load().entries) {
      if (!entry || !Array.isArray(entry.records)) {
        throw new Error(`Corrupt Discord awareness journal entry ${id}`);
      }
      if (entry.v !== undefined && entry.v !== JOURNAL_FORMAT) {
        throw new Error(
          `Discord awareness journal entry ${id} is in format ${String(entry.v)}, which this build can't read ` +
            `(it reads format ${JOURNAL_FORMAT}); a later build wrote it`,
        );
      }
      applyRecords(state, entry.records);
    }
    // The import appends through this state, so it is cached first. An
    // import that fails takes it back: every later read rebuilds and tries
    // the import again, rather than answering without it.
    this.state = state;
    try {
      this.importLegacyLedger(state);
    } catch (error) {
      this.state = null;
      throw error;
    }
    return state;
  }

  /**
   * Import a pre-journal ledger beside the store, then rename it. A file
   * whose hash was imported before is only renamed, and a batch the journal
   * already holds is never imported again, so a restored or re-saved copy of
   * an imported ledger changes nothing (see importLegacy).
   */
  private importLegacyLedger(state: JournalState): void {
    if (!this.legacyPath) return;
    let raw: string;
    try {
      raw = readFileSync(this.legacyPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(
        `Could not read Discord awareness ledger ${this.legacyPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (!state.importedSources.has(sha256)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Invalid Discord awareness ledger ${this.legacyPath}`);
      }
      const imported = importLegacy(parsed, this.legacyPath, sha256, state.batches);
      this.append(imported.records, { durable: true });
      this.importedUnsent = imported.unsent;
      if (imported.unsent.length > 0) {
        console.error(
          `[discord-awareness] imported ${basename(this.legacyPath)}: ${imported.unsent.length} batch(es) had marks ` +
            'agent-framework 0.22.x had still to add or remove, and none of them will be sent, since nobody chose them: ' +
            imported.unsent.map((batch) => `batch ${batch.batchId} (${batch.agentName}, ${batch.sourceBranch} to ` +
              `${batch.targetBranch}): ${batch.adds} to add, ${batch.removals} to remove`).join('; ') +
            '. A batch 0.22.x never activated placed no marks; retracting a batch takes off the mark of its emoji ' +
            'from each of its messages, whichever batch placed it',
        );
      }
    }
    // Imported (now or by an earlier process that stopped before renaming):
    // the file is inert; move it out of the way. A copy retired earlier stays
    // as it is: a later one is kept beside it under its own hash.
    if (!existsSync(this.legacyPath)) return;
    const retired = `${this.legacyPath}.migrated-v2`;
    try {
      renameSync(this.legacyPath, existsSync(retired) ? `${retired}.${sha256.slice(0, 12)}` : retired);
    } catch (error) {
      console.error(
        `[discord-awareness] imported ${basename(this.legacyPath)} but could not rename it: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Append one group of records as one journal entry and apply it. A failed
   * append leaves the state to be rebuilt from the journal before the next
   * operation: one whose record reached this process's view (a barrier
   * failed) is read back with it, and one that failed inside the store
   * leaves the journal refusing until the store is reopened (see load).
   */
  private append(records: JournalRecord[], opts: AppendOptions = {}): void {
    if (records.length === 0) return;
    const state = this.load();
    try {
      this.journal.append({ v: JOURNAL_FORMAT, records }, opts);
    } catch (error) {
      this.state = null;
      throw error;
    }
    applyRecords(state, records);
  }
}

// ---------------------------------------------------------------------------
// Fold and legacy import
// ---------------------------------------------------------------------------

function emptyState(): JournalState {
  return {
    batches: new Map(),
    ops: new Map(),
    byKey: new Map(),
    liveKeys: new Set(),
    legacy: new Map(),
    retracts: new Map(),
    importedSources: new Set(),
    position: 0,
  };
}

/** Requests in these records that are not recorded superseded with them. */
function liveRequests(records: JournalRecord[]): number {
  const cancelled = new Set(records.filter((record) => record.t === 'op-cancelled').map((record) => (record as { opId: string }).opId));
  return records.filter((record) => record.t === 'requested' && !cancelled.has(record.opId)).length;
}

function addLegacyEvidence(state: JournalState, evidence: DiscordAwarenessLegacyEvidence): void {
  const key = markKey(evidence.key);
  const list = state.legacy.get(key);
  if (list) list.push(evidence);
  else state.legacy.set(key, [evidence]);
}

/** Apply one entry's records, in order, to the reduced state. Each record
 *  takes the next journal position. */
function applyRecords(state: JournalState, records: JournalRecord[]): void {
  // The keys whose operations these records change, whose liveness is
  // settled once they are all applied.
  const touched = new Set<string>();
  const touch = (op: DiscordAwarenessOp | undefined): void => { if (op) touched.add(markKey(op.key)); };
  for (const record of records) {
    const position = ++state.position;
    switch (record.t) {
      case 'batch':
        if (!state.batches.has(record.batch.id)) {
          state.batches.set(record.batch.id, { ...structuredClone(record.batch), status: 'prepared', authorization: position });
        }
        break;
      case 'activated': {
        const batch = state.batches.get(record.batchId);
        if (batch && batch.status !== 'discarded') {
          batch.status = 'active';
          // Only a surgery (or its resume) activates a suppression, after its
          // last redaction synced: activation records the body complete.
          // Release does not, and neither does an imported `active`.
          if (batch.suppressionIntervals?.length) batch.suppressionComplete = true;
        }
        break;
      }
      case 'legacy-activated': {
        const batch = state.batches.get(record.batchId);
        if (batch && batch.status !== 'discarded') batch.status = 'active';
        break;
      }
      case 'discarded': {
        // A retirement, of a prepared batch (isSurgeryLeftover).
        const batch = state.batches.get(record.batchId);
        if (batch && isSurgeryLeftover(batch)) batch.status = 'discarded';
        break;
      }
      case 'held':
        // A pre-release build's hold: nothing it held is ever sent, and the
        // batch stays as it was (see the record's type).
        break;
      case 'released': {
        // A pre-release build's release of a held batch, a surgery's or an
        // import's: its requests follow in the same entry, under this
        // authorization.
        const batch = state.batches.get(record.batchId);
        if (batch && batch.status !== 'discarded' && batch.releaseAuthorization === undefined) {
          batch.status = 'active';
          batch.releaseAuthorization = position;
        }
        break;
      }
      case 'cancelled': {
        const batch = state.batches.get(record.batchId);
        if (batch && !batch.cancelled) {
          batch.cancelled = { at: record.at, ...(record.by ? { by: record.by } : {}) };
        }
        break;
      }
      case 'requested':
        if (!state.ops.has(record.opId)) {
          const op: DiscordAwarenessOp = {
            opId: record.opId,
            key: { ...record.key },
            action: record.action,
            cause: { ...record.cause },
            authorization: authorizationOf(state, record.cause) ?? position,
            requestedAt: record.at,
            attempts: [],
          };
          state.ops.set(record.opId, op);
          const key = markKey(op.key);
          const entry = state.byKey.get(key);
          if (entry) entry.ops.push(op);
          else state.byKey.set(key, { order: state.byKey.size, ops: [op] });
          touch(op);
        }
        break;
      case 'op-cancelled': {
        const op = state.ops.get(record.opId);
        if (op && !op.cancelled) op.cancelled = { at: record.at, reason: record.reason };
        touch(op);
        break;
      }
      case 'dispatching': {
        const op = state.ops.get(record.opId);
        touch(op);
        if (op && !op.attempts.some((attempt) => attempt.attempt === record.attempt)) {
          op.attempts.push({
            attempt: record.attempt,
            ...(record.dispatchId ? { dispatchId: record.dispatchId } : {}),
            dispatchedAt: record.at,
          });
        }
        break;
      }
      case 'outcome': {
        const op = state.ops.get(record.opId);
        touch(op);
        const attempt = op?.attempts.find((candidate) => candidate.attempt === record.attempt);
        if (attempt && attempt.outcome === undefined) {
          attempt.outcome = record.outcome;
          attempt.outcomeAt = record.at;
          if (record.permanent) attempt.permanent = true;
          if (record.error !== undefined) attempt.error = record.error;
        }
        break;
      }
      case 'suppression-complete': {
        const batch = state.batches.get(record.batchId);
        if (batch) batch.suppressionComplete = true;
        break;
      }
      case 'suppression-abandoned': {
        const batch = state.batches.get(record.batchId);
        if (batch) batch.suppressionAbandoned = true;
        break;
      }
      case 'legacy-evidence':
        addLegacyEvidence(state, structuredClone(record.evidence));
        break;
      case 'retract':
        if (!state.retracts.has(record.requestId)) {
          state.retracts.set(record.requestId, {
            requestId: record.requestId,
            target: record.target,
            at: record.at,
            ...(record.by ? { by: record.by } : {}),
            authorization: position,
          });
        }
        break;
      case 'request-cancelled': {
        const retract = state.retracts.get(record.requestId);
        if (retract && !retract.cancelled) {
          retract.cancelled = { at: record.at, ...(record.by ? { by: record.by } : {}) };
        }
        break;
      }
      case 'import-complete':
        state.importedSources.add(record.sha256);
        break;
      default:
        break;
    }
  }
  for (const key of touched) {
    if (state.byKey.get(key)!.ops.some((op) => !opEnded(op))) state.liveKeys.add(key);
    else state.liveKeys.delete(key);
  }
}

/**
 * Whether an operation's work has ended, so its key needs nothing more for
 * it: it was cancelled or superseded, confirmed, refused for good, or
 * brought to the bound of unconfirmed attempts. One not cancelled that is
 * on the wire, or was left there by a previous process, hasn't ended.
 * headDispatch decides what is due among the operations that haven't, and
 * holds a key while an attempt this process sent for it, a cancelled one's
 * included, awaits its outcome.
 */
function opEnded(op: DiscordAwarenessOp): boolean {
  if (op.cancelled) return true;
  const last = op.attempts.at(-1);
  if (!last || last.outcome === undefined || last.outcome === 'not-sent') return false;
  if (last.outcome === 'confirmed') return true;
  if (last.outcome === 'failed' && last.permanent) return true;
  return unconfirmedAttempts(op) >= MAX_UNCONFIRMED_ATTEMPTS;
}

/** The journal position of the act a request carries out. */
function authorizationOf(state: JournalState, cause: DiscordAwarenessOpCause): number | undefined {
  if (cause.kind === 'batch' && cause.batchId) return state.batches.get(cause.batchId)?.authorization;
  if (cause.kind === 'release' && cause.batchId) return state.batches.get(cause.batchId)?.releaseAuthorization;
  if (cause.kind === 'retract' && cause.requestId) return state.retracts.get(cause.requestId)?.authorization;
  return undefined;
}

interface LegacyEntry extends DiscordAwarenessRef {
  desired?: boolean;
  markerPresent?: boolean;
  deliveryStatus?: 'pending' | 'applied' | 'permanent-failure';
  attempts?: number;
  lastAction?: DiscordAwarenessAction;
  lastAttemptAt?: number;
  lastError?: string;
}

interface LegacyBatch {
  id: string;
  status: 'prepared' | 'active' | 'pending';
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  emoji: string;
  createdAt: number;
  refs: LegacyEntry[];
  activationPolicy?: 'target-branch' | 'explicit';
  suppressionIntervals?: DiscordSuppressionInterval[];
}

/**
 * Whether a parsed pre-journal ledger is one the released readers accepted
 * (every release with the outbox, 0.6.7 to 0.22.2, checked these fields
 * alike): version 1, whose batches are `prepared` or `pending` with plain
 * refs, or version 2, whose batches are `prepared` or `active`, with an
 * activation policy and suppression intervals of the shapes they wrote, and
 * refs that are full entries.
 */
function isLegacyLedger(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const document = value as { version?: unknown; batches?: unknown };
  if ((document.version !== 1 && document.version !== 2) || !Array.isArray(document.batches)) return false;
  const v1 = document.version === 1;
  return document.batches.every((batch) => {
    if (!batch || typeof batch !== 'object') return false;
    const candidate = batch as Record<string, unknown>;
    return typeof candidate.id === 'string'
      && (v1
        ? candidate.status === 'prepared' || candidate.status === 'pending'
        : candidate.status === 'prepared' || candidate.status === 'active')
      && typeof candidate.agentName === 'string'
      && typeof candidate.sourceBranch === 'string'
      && typeof candidate.targetBranch === 'string'
      && typeof candidate.emoji === 'string'
      && typeof candidate.createdAt === 'number'
      && Array.isArray(candidate.refs)
      && (v1
        ? candidate.refs.every((ref: unknown) => !!ref && typeof ref === 'object'
          && typeof (ref as Record<string, unknown>).serverId === 'string'
          && typeof (ref as Record<string, unknown>).channelId === 'string'
          && typeof (ref as Record<string, unknown>).messageId === 'string')
        : (candidate.activationPolicy === undefined
          || candidate.activationPolicy === 'target-branch'
          || candidate.activationPolicy === 'explicit')
          && (candidate.suppressionIntervals === undefined
            || (Array.isArray(candidate.suppressionIntervals)
              && candidate.suppressionIntervals.every((interval: unknown) => !!interval && typeof interval === 'object'
                && typeof (interval as Record<string, unknown>).fromId === 'string'
                && typeof (interval as Record<string, unknown>).toId === 'string')))
          && candidate.refs.every(isLegacyEntry));
  });
}

/** Whether a version 2 ledger's ref is an entry as the released readers required it. */
function isLegacyEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.serverId === 'string'
    && typeof entry.channelId === 'string'
    && typeof entry.messageId === 'string'
    && typeof entry.desired === 'boolean'
    && typeof entry.markerPresent === 'boolean'
    && (entry.deliveryStatus === 'pending' || entry.deliveryStatus === 'applied' || entry.deliveryStatus === 'permanent-failure')
    && typeof entry.attempts === 'number'
    && (entry.lastAction === undefined || entry.lastAction === 'add' || entry.lastAction === 'remove')
    && (entry.lastAttemptAt === undefined || typeof entry.lastAttemptAt === 'number')
    && (entry.lastError === undefined || typeof entry.lastError === 'string');
}

/**
 * Translate a version 1 or 2 ledger into journal records, ending with an
 * `import-complete` record carrying the file's hash. Batches keep their ids.
 * What the old ledger recorded about each ref is kept as legacy evidence:
 * facts (attempt count, last action, status and error), never synthesized
 * attempts and never a judgment about what is on Discord. The work it had
 * still to do (its pending adds and removals, and every mark of a batch it
 * never activated) is retired, none of it sent, and returned in `unsent`:
 * it was queued before marks were an explicit choice, so nobody chose it.
 * A batch it never activated is retired whole, except a suppression whose
 * body may be pending on its branch, which stays prepared, as an
 * interrupted surgery's does, for a start on that branch to finish and
 * retire (see pendingSuppressionsFor). Nothing imported is ever dispatched;
 * a retract of a batch takes off the mark of its emoji from each of its
 * messages, whichever batch placed it, the marks 0.22.x placed among them.
 *
 * Each batch is imported once. A batch the journal already holds, or a
 * second listing of one in this file, is skipped whole: its evidence would
 * be counted twice. Batches new to the journal import as above.
 */
function importLegacy(
  parsed: unknown,
  path: string,
  sha256: string,
  journalBatches: ReadonlyMap<string, unknown>,
): { records: JournalRecord[]; unsent: DiscordAwarenessImportedUnsent[] } {
  // A ledger the released readers would have refused is refused here too,
  // never read for a meaning: a malformed field (`activationPolicy:
  // 'explicit '`) would otherwise retire a suppression whose removals a
  // start on its branch still owes.
  if (!isLegacyLedger(parsed)) throw new Error(`Invalid Discord awareness ledger ${path}`);
  const document = parsed as { version: 1 | 2; batches: unknown[] };
  const at = Date.now();
  const records: JournalRecord[] = [];
  const unsent: DiscordAwarenessImportedUnsent[] = [];
  const imported = new Set<string>();
  for (const raw of document.batches as LegacyBatch[]) {
    if (journalBatches.has(raw.id) || imported.has(raw.id)) continue;
    imported.add(raw.id);
    const legacyActive = raw.status === 'active' || raw.status === 'pending';
    const refs = raw.refs.map((entry) => ({
      serverId: entry.serverId,
      channelId: entry.channelId,
      messageId: entry.messageId,
    }));
    records.push({
      t: 'batch',
      at: raw.createdAt,
      batch: {
        id: raw.id,
        agentName: raw.agentName,
        sourceBranch: raw.sourceBranch,
        targetBranch: raw.targetBranch,
        emoji: raw.emoji,
        createdAt: raw.createdAt,
        scope: 'legacy',
        refs,
        ...(raw.activationPolicy ? { activationPolicy: raw.activationPolicy } : {}),
        ...(raw.suppressionIntervals?.length ? { suppressionIntervals: raw.suppressionIntervals } : {}),
      },
    });
    // Its marks were active. That is history, not proof of a suppression's
    // body: the old ledger could record activation before the redactions
    // were synced, so a startup on the target still verifies and resumes
    // the intervals before recording the body complete.
    if (legacyActive) records.push({ t: 'legacy-activated', at: raw.createdAt, batchId: raw.id });
    let adds = 0;
    let removals = 0;
    for (const entry of raw.refs) {
      const key = { serverId: entry.serverId, channelId: entry.channelId, messageId: entry.messageId, emoji: raw.emoji };
      // v1 entries carry no delivery state. A v1 batch is `prepared` or
      // `pending`, and `pending` was the active one, every mark still to
      // deliver: its entries are pending, a prepared one's are not.
      const status = entry.deliveryStatus ?? (raw.status === 'pending' ? 'pending' : 'applied');
      const desired = entry.desired ?? raw.status === 'pending';
      // What 0.22.x had still to do for this ref, retired here.
      if ((!legacyActive || status === 'pending') && (!legacyActive || desired || entry.markerPresent)) {
        if (desired || !legacyActive) adds++;
        else removals++;
      }
      if (entry.attempts && entry.attempts > 0 && entry.lastAction) {
        records.push({ t: 'legacy-evidence', at, evidence: legacyEvidence(raw.id, key, entry, status) });
      }
    }
    // A batch 0.22.x never activated is retired, unless its
    // suppression's body may be pending (isPendingSuppression's test for a
    // batch new to the journal): that one stays prepared for a start on its
    // branch, which finishes the body and retires it.
    const pendingBody = raw.activationPolicy === 'explicit' && !!raw.suppressionIntervals?.length;
    if (!legacyActive && !pendingBody) records.push({ t: 'discarded', at, batchId: raw.id });
    if (adds + removals > 0) {
      unsent.push({
        batchId: raw.id,
        agentName: raw.agentName,
        sourceBranch: raw.sourceBranch,
        targetBranch: raw.targetBranch,
        adds,
        removals,
      });
    }
  }
  records.push({ t: 'import-complete', at, source: document.version === 1 ? 'v1' : 'v2', sha256 });
  return { records, unsent };
}

/**
 * The facts a v2 entry recorded about its attempts, and what they leave open.
 * Only `lastError` speaks to the last attempt's outcome (the old writer
 * cleared it on success and set it on failure); `deliveryStatus` was its
 * reconciliation state, rewritten by branch switches without any request,
 * and is kept as that and nothing more.
 */
function legacyEvidence(
  batchId: string,
  key: DiscordAwarenessRef & { emoji: string },
  entry: LegacyEntry,
  oldDeliveryStatus: 'pending' | 'applied' | 'permanent-failure',
): DiscordAwarenessLegacyEvidence {
  const attempts = entry.attempts!;
  const lastError = entry.lastError;
  const lastErrorKind = lastError === undefined ? undefined
    : PRE_WRITE_REFUSAL.test(lastError) ? 'pre-write-refusal'
    : isPermanentDiscordReactionFailure(lastError) ? 'discord-answer'
    : 'other';
  const lastOutcome = lastErrorKind === undefined ? 'confirmed'
    : lastErrorKind === 'pre-write-refusal' ? 'not-sent'
    : lastErrorKind === 'discord-answer' ? 'refused'
    : 'unrecorded';
  return {
    batchId,
    key: { ...key },
    attempts,
    lastAction: entry.lastAction!,
    lastOutcome,
    oldDeliveryStatus,
    ...(lastError !== undefined ? { lastError: boundDiscordAwarenessText(lastError) } : {}),
    ...(lastErrorKind ? { lastErrorKind } : {}),
    outcomesUnrecorded: (attempts - 1) + (lastOutcome === 'unrecorded' ? 1 : 0),
  };
}

/** A batch a start treats as an interrupted surgery's: one still prepared.
 *  An import's batch that agent-framework 0.22.x never activated is one too,
 *  when its import kept it for its suppression's body (see importLegacy). */
function isSurgeryLeftover(batch: DiscordAwarenessBatch): boolean {
  return batch.status === 'prepared';
}

/**
 * A suppression whose body may still need applying on its target branch: it
 * names removal intervals (`explicit`), its body was never recorded complete
 * or given up, and it isn't retired. A retired batch is never resumed: its
 * surgery gave the body up after putting the source back, completeSuppression
 * retired it once a start finished its body, or startup gave it up when its
 * branch was gone.
 */
function isPendingSuppression(batch: DiscordAwarenessBatch): boolean {
  return batch.status !== 'discarded'
    && !batch.suppressionComplete
    && !batch.suppressionAbandoned
    && batch.activationPolicy === 'explicit'
    && !!batch.suppressionIntervals?.length;
}

/** A new batch's record, or null when it carries neither marks nor a
 *  suppression journal. */
function batchRecord(input: DiscordAwarenessPrepareInput): DiscordAwarenessBatchRecord | null {
  const refs = dedupeRefs(input.refs);
  if (refs.length === 0 && !input.suppressionIntervals?.length) return null;
  return {
    id: randomUUID(),
    agentName: input.agentName,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    emoji: input.emoji ?? DEFAULT_DISCORD_AWARENESS_EMOJI,
    createdAt: Date.now(),
    scope: input.scope,
    refs,
    ...(input.unmarked ? { unmarked: input.unmarked } : {}),
    ...(input.notRemoved ? { notRemoved: input.notRemoved } : {}),
    activationPolicy: input.activationPolicy ?? 'target-branch',
    ...(input.suppressionIntervals?.length
      ? { suppressionIntervals: input.suppressionIntervals.map((interval) => ({ ...interval })) }
      : {}),
  };
}

function errorText(error: unknown): string {
  return boundDiscordAwarenessText(error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function dedupeRefs(refs: DiscordAwarenessRef[]): DiscordAwarenessRef[] {
  const deduped = new Map<string, DiscordAwarenessRef>();
  for (const ref of refs) {
    if (!ref.serverId || !ref.channelId || !ref.messageId) continue;
    deduped.set(refKey(ref), { serverId: ref.serverId, channelId: ref.channelId, messageId: ref.messageId });
  }
  return [...deduped.values()];
}

function uniqueKeys(keys: Array<DiscordAwarenessRef & { emoji: string }>): Array<DiscordAwarenessRef & { emoji: string }> {
  const unique = new Map<string, DiscordAwarenessRef & { emoji: string }>();
  for (const key of keys) unique.set(markKey(key), key);
  return [...unique.values()];
}

function refKey(ref: DiscordAwarenessRef): string {
  return `${ref.serverId}\0${ref.channelId}\0${ref.messageId}`;
}

function markKey(key: DiscordAwarenessRef & { emoji: string }): string {
  return `${key.emoji}\0${refKey(key)}`;
}

/**
 * Unconfirmed attempts (Discord refused them, or no answer came, so they may
 * have landed) after which an operation is not sent again. An attempt
 * refused before it left the host (`not-sent`) isn't counted. Without a
 * bound, a refusal Discord repeats, or a server that never answers, would be
 * sent again at every drain, two journal records each time.
 */
const MAX_UNCONFIRMED_ATTEMPTS = 3;

function unconfirmedAttempts(op: DiscordAwarenessOp): number {
  return op.attempts.filter((attempt) => attempt.outcome === 'failed' || attempt.outcome === 'unknown').length;
}

/** Unresolved requests among these operations' attempts, one per dispatch. */
function unresolvedDispatches(
  ops: DiscordAwarenessOp[],
  unresolved: (op: DiscordAwarenessOp, attempt: DiscordAwarenessAttempt) => boolean,
): number {
  const dispatches = new Set<string>();
  for (const op of ops) {
    for (const attempt of op.attempts) {
      if (unresolved(op, attempt)) dispatches.add(attempt.dispatchId ?? `${op.opId}#${attempt.attempt}`);
    }
  }
  return dispatches.size;
}

function emptyCounts(): Record<DiscordAwarenessOpStatus, number> {
  return { requested: 0, dispatching: 0, confirmed: 0, failed: 0, unknown: 0, cancelled: 0 };
}

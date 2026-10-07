import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Discord awareness marks: a reaction (💤 by default) that an operator may
 * choose to place on Discord messages a surgery removed from a resident's
 * context, so the people who wrote them can see the resident no longer has
 * them in view.
 *
 * Marks are an explicit publication choice, separate from the surgery itself
 * (`DiscordAwarenessMarks`, default `none`). Once requested, they are
 * one-shot: branch moves and restarts never derive new operations from branch
 * state; an operator retracts, cancels or releases explicitly.
 *
 * The ledger is an append-only journal of what was asked and what was
 * answered, never a model of what is on Discord. Each operation is recorded
 * as `requested`, then `dispatching` (written before the request can leave),
 * then an outcome. A request that was dispatched and never answered stays
 * `unknown` for good: a later retry's confirmation does not resolve it, and a
 * later opposite operation discloses it.
 *
 * Operations are keyed by (MCPL server id, channel, message, emoji). The
 * server id is the configured route to a bot, not the bot's identity: if the
 * route is re-pointed at another bot, retained operations act as that bot,
 * and nothing here can detect it.
 */

export const DEFAULT_DISCORD_AWARENESS_EMOJI = '💤';

/** The journal file under a store, next to the other recovery state. */
/**
 * Bound text that came from elsewhere (a Discord error body, a filesystem
 * error) before it is journaled, logged or returned in a receipt: the journal
 * is re-read on every operation, and a server's error text has no length
 * limit of its own. Head and tail are kept, with the omitted length stated;
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

export function defaultDiscordAwarenessOutboxPath(storePath: string): string {
  return join(storePath, 'recovery', 'discord-awareness-journal.jsonl');
}

/** The pre-journal (version 1 and 2) ledger file name, imported once. */
const LEGACY_LEDGER_NAME = 'discord-awareness-outbox.json';

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

export interface DiscordAwarenessReleaseAction extends DiscordAwarenessRef {
  action: DiscordAwarenessAction;
  /** Earlier attempts recorded for this ref before it was held (legacy import). */
  priorAttempts?: number;
  /** The last error recorded for this ref before it was held, verbatim. */
  priorError?: string;
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
   * `target-branch`: startup activates the batch only if its target is
   * exactly the active branch (the surgery crashed after switching).
   * `explicit`: only the surgery (or startup's resume of its intervals) does.
   */
  activationPolicy?: 'target-branch' | 'explicit';
  /** Idempotent interval operations used to resume an interrupted suppression. */
  suppressionIntervals?: DiscordSuppressionInterval[];
}

export type DiscordAwarenessBatchStatus = 'prepared' | 'active' | 'held' | 'discarded';

export interface DiscordAwarenessBatch extends DiscordAwarenessBatchRecord {
  status: DiscordAwarenessBatchStatus;
  /** A held suppression whose body was completed at a later startup. */
  suppressionComplete?: boolean;
  held?: { reason: string; at: number; releaseActions: DiscordAwarenessReleaseAction[] };
  cancelled?: { at: number; by?: string };
  released?: { at: number; by?: string };
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
  requestedAt: number;
  attempts: DiscordAwarenessAttempt[];
  cancelled?: { at: number; reason: 'batch-cancelled' | 'superseded' };
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
  batchId: string;
  /** Requests that will now never be sent (for a batch not yet activated,
   *  every mark it would have requested). */
  cancelled: number;
  /** Held release actions dropped (a held batch was cancelled). */
  heldDropped: number;
  /** Operations on the wire right now: they may still land. */
  inFlight: number;
  /** Operations whose outcome is unknown: they may have landed. */
  unknown: number;
  /** Operations Discord already confirmed (cancel does not undo them). */
  confirmed: number;
}

/** Receipt for retract(). */
export interface DiscordAwarenessRetractReceipt {
  requestId: string;
  /** Removals queued (one per reaction key). */
  removalsQueued: number;
  /** Add requests for those keys that had not been sent, now superseded. */
  addsSuperseded: number;
  /** Keys whose earlier add attempts are unresolved (on the wire or unknown):
   *  such an add may land after this removal. */
  keysWithUnresolvedAdds: number;
  /** Unresolved earlier add requests on those keys (one per request sent,
   *  however many batches' operations it carried). */
  unresolvedAddAttempts: number;
}

export interface DiscordAwarenessReleaseReceipt {
  batchId: string;
  addsQueued: number;
  removalsQueued: number;
}

/** Per-batch view for operators: what was asked and what is known. */
export interface DiscordAwarenessBatchView {
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
  held?: { reason: string; at: number; releaseActions: number };
  cancelled?: { at: number; by?: string };
  released?: { at: number; by?: string };
  /** Counts over the add operations this batch requested, by status. */
  adds: Record<DiscordAwarenessOpStatus, number>;
  /** Removals requested (by any retract) on this batch's refs, by status. */
  removals: Record<DiscordAwarenessOpStatus, number>;
  /** Attempts on this batch's refs whose outcome is unknown or on the wire. */
  unresolvedAttempts: number;
}

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
  | { t: 'discarded'; at: number; batchId: string }
  | { t: 'held'; at: number; batchId: string; reason: string; releaseActions: DiscordAwarenessReleaseAction[] }
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
  | { t: 'op-cancelled'; at: number; opId: string; reason: 'batch-cancelled' | 'superseded' }
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
  | { t: 'suppression-complete'; at: number; batchId: string }
  | { t: 'import-complete'; at: number; source: 'v2'; sha256: string }
  | { t: 'commit'; at: number; txn: string };

/**
 * Every multi-record append is one transaction: its records carry a `txn`
 * id and only take effect when the closing `commit` record is present. A
 * torn append (disk full, crash mid-write) therefore applies none of its
 * records, never a prefix, so an activation can't half-queue its marks and a
 * retract can't supersede adds without queuing its removals.
 */
type StoredRecord = JournalRecord & { txn?: string };

interface JournalState {
  batches: Map<string, DiscordAwarenessBatch>;
  /** Operations in request order. */
  ops: Map<string, DiscordAwarenessOp>;
  importedSources: Set<string>;
}

/**
 * The durable awareness-mark ledger: an append-only journal (one JSON record
 * per line, each append fsynced) and the operations derived from it.
 */
export class DiscordAwarenessOutbox {
  readonly path: string;
  private readonly legacyPath: string;
  /** Operations dispatched by this process and still awaiting an outcome. */
  private readonly inFlight = new Set<string>();

  /**
   * @param path the journal file. A path ending in `.json` names a pre-journal
   * ledger (as an older `discordAwarenessOutboxPath` would): the journal then
   * lives beside it as `<name>.journal.jsonl` and the file itself is imported.
   */
  constructor(path: string) {
    if (path.endsWith('.json')) {
      this.legacyPath = path;
      this.path = `${path.slice(0, -'.json'.length)}.journal.jsonl`;
    } else {
      this.path = path;
      this.legacyPath = join(dirname(path), LEGACY_LEDGER_NAME);
    }
  }

  // -- surgery side -----------------------------------------------------------

  /**
   * Record a surgery's request before its branch switch. Returns null when it
   * carries neither marks nor a suppression journal. A prepared batch never
   * delivers: activate() (or startup's crash completion) does.
   */
  prepare(input: {
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
  }): DiscordAwarenessBatch | null {
    const refs = dedupeRefs(input.refs);
    if (refs.length === 0 && !input.suppressionIntervals?.length) return null;
    const batch: DiscordAwarenessBatchRecord = {
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
    this.append([{ t: 'batch', at: batch.createdAt, batch }]);
    return { ...structuredClone(batch), status: 'prepared' };
  }

  /**
   * Activate a prepared batch after its body change landed: one `add` request
   * per ref, durable before this returns. Returns how many were queued.
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
    records.push(...this.requestRecords(state, batch.refs.map((ref) => ({ ...ref, action: 'add' as const })), batch.emoji, {
      kind: 'batch',
      batchId,
    }, at));
    this.append(records);
    return batch.refs.length;
  }

  /**
   * Retire a batch whose surgery did not complete. Only a prepared batch can
   * be discarded; returns false when nothing was retired.
   */
  discard(batchId: string): boolean {
    const batch = this.load().batches.get(batchId);
    if (!batch || batch.status !== 'prepared') return false;
    this.append([{ t: 'discarded', at: Date.now(), batchId }]);
    return true;
  }

  /**
   * Suppressions whose body may still need resuming on the active branch:
   * explicit batches with intervals whose target is exactly that branch,
   * prepared (crash completion: resume, then activate) or held at an earlier
   * startup (resume the body only; marks stay held). Branch ancestry is never
   * consulted.
   */
  preparedSuppressionsForBranch(branchName: string): DiscordAwarenessBatch[] {
    return [...this.load().batches.values()]
      .filter((batch) => (batch.status === 'prepared' || batch.status === 'held')
        && !batch.suppressionComplete
        && batch.activationPolicy === 'explicit'
        && !!batch.suppressionIntervals?.length
        && batch.targetBranch === branchName)
      .map((batch) => structuredClone(batch));
  }

  /** Record that a held suppression's body was completed (its marks stay held). */
  recordSuppressionComplete(batchId: string): void {
    this.append([{ t: 'suppression-complete', at: Date.now(), batchId }]);
  }

  /**
   * Startup reconciliation, run once before any delivery. It derives nothing
   * from branch ancestry:
   * - an attempt left `dispatching` by a previous process is recorded
   *   `unknown` (it may have reached Discord);
   * - a prepared batch whose target is exactly the active branch completes
   *   its crash window (activated), except a suppression, whose resume
   *   completes its body first;
   * - any other prepared batch is held for an operator;
   * - a batch an operator cancelled while it was prepared stays as it is.
   */
  recoverAtStartup(activeBranchName: string): { activated: string[]; held: string[]; unknownAttempts: number } {
    const state = this.load();
    const at = Date.now();
    const records: JournalRecord[] = [];
    let unknownAttempts = 0;
    for (const op of state.ops.values()) {
      for (const attempt of op.attempts) {
        if (attempt.outcome !== undefined) continue;
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
    const activated: string[] = [];
    const held: string[] = [];
    for (const batch of state.batches.values()) {
      if (batch.status !== 'prepared' || batch.cancelled) continue;
      const suppression = (batch.activationPolicy ?? 'target-branch') === 'explicit'
        && !!batch.suppressionIntervals?.length;
      if (batch.targetBranch === activeBranchName) {
        if (suppression) continue; // resumePreparedDiscordSuppressions completes it

        records.push({ t: 'activated', at, batchId: batch.id });
        records.push(...this.requestRecords(
          state,
          batch.refs.map((ref) => ({ ...ref, action: 'add' as const })),
          batch.emoji,
          { kind: 'batch', batchId: batch.id },
          at,
        ));
        activated.push(batch.id);
      } else {
        records.push({
          t: 'held',
          at,
          batchId: batch.id,
          reason: suppression
            ? `its suppression on ${batch.targetBranch} was interrupted; the body resumes when that branch is active at startup, the marks only on release`
            : `its surgery was interrupted before the switch to ${batch.targetBranch} was confirmed`,
          releaseActions: batch.refs.map((ref) => ({ ...ref, action: 'add' })),
        });
        held.push(batch.id);
      }
    }
    if (records.length > 0) this.append(records);
    return { activated, held, unknownAttempts };
  }

  // -- operator controls ------------------------------------------------------

  /**
   * Stop all future dispatch and retry of a batch's requests: unsent ones,
   * ones on the wire (their outcome is still recorded when it comes), and
   * ones whose outcome is unknown. A held batch's release actions are
   * dropped. Nothing is ever removed from Discord by a cancel: the receipt
   * reports what may already have landed, and retract removes it.
   */
  cancel(batchId: string, by?: string): DiscordAwarenessCancelReceipt {
    const state = this.load();
    const batch = state.batches.get(batchId);
    if (!batch) throw new Error(`Discord awareness batch not found: ${batchId}`);
    const receipt: DiscordAwarenessCancelReceipt = {
      batchId,
      // A prepared batch (its surgery still running, or its bookkeeping
      // unresolved) has no requests yet: every one of its marks is stopped.
      cancelled: batch.status === 'prepared' && !batch.cancelled ? batch.refs.length : 0,
      heldDropped: batch.held?.releaseActions.length ?? 0,
      inFlight: 0,
      unknown: 0,
      confirmed: 0,
    };
    if (batch.cancelled) return receipt;
    const at = Date.now();
    const records: JournalRecord[] = [{ t: 'cancelled', at, batchId, ...(by ? { by } : {}) }];
    for (const op of state.ops.values()) {
      if (op.cause.batchId !== batchId) continue;
      const status = this.opStatus(op);
      if (status === 'confirmed') {
        receipt.confirmed++;
        continue;
      }
      if (status === 'requested') receipt.cancelled++;
      else if (status === 'dispatching') receipt.inFlight++;
      else if (status === 'unknown') receipt.unknown++;
      else continue; // failed or already cancelled
      records.push({ t: 'op-cancelled', at, opId: op.opId, reason: 'batch-cancelled' });
    }
    this.append(records);
    return receipt;
  }

  /**
   * Remove this bot's mark (through the configured route) from a batch's refs,
   * or from every ref any batch ever sent an add for. Acts across batches: a
   * reaction is one per (route, message, emoji), whichever batches asked for
   * it. Keys where no add attempt ever left the host are skipped. Add
   * requests not yet sent for those keys are superseded. The removal is
   * always sent, whatever earlier outcomes say.
   */
  retract(target: string | 'all', by?: string): DiscordAwarenessRetractReceipt {
    const state = this.load();
    let candidateKeys: Array<DiscordAwarenessRef & { emoji: string }>;
    if (target === 'all') {
      candidateKeys = uniqueKeys([...state.ops.values()].filter((op) => op.action === 'add').map((op) => op.key));
    } else {
      const batch = state.batches.get(target);
      if (!batch) throw new Error(`Discord awareness batch not found: ${target}`);
      candidateKeys = batch.refs.map((ref) => ({ ...ref, emoji: batch.emoji }));
    }
    const requestId = randomUUID();
    const at = Date.now();
    const receipt: DiscordAwarenessRetractReceipt = {
      requestId,
      removalsQueued: 0,
      addsSuperseded: 0,
      keysWithUnresolvedAdds: 0,
      unresolvedAddAttempts: 0,
    };
    const toRemove: Array<DiscordAwarenessRef & { emoji: string; action: DiscordAwarenessAction }> = [];
    const records: JournalRecord[] = [{ t: 'retract', at, requestId, target, ...(by ? { by } : {}) }];
    for (const key of candidateKeys) {
      const adds = this.opsForKey(state, key).filter((op) => op.action === 'add');
      const left = adds.some((op) => op.attempts.some((attempt) => attempt.outcome !== 'not-sent'));
      if (!left) {
        // Nothing was ever sent for this key: stop its unsent adds, and
        // there is no reaction of ours to remove.
        for (const op of adds) {
          if (this.opStatus(op) !== 'requested') continue;
          records.push({ t: 'op-cancelled', at, opId: op.opId, reason: 'superseded' });
          receipt.addsSuperseded++;
        }
        continue;
      }
      const unresolved = unresolvedDispatches(adds, (op, attempt) => this.attemptUnresolved(op, attempt));
      if (unresolved > 0) {
        receipt.keysWithUnresolvedAdds++;
        receipt.unresolvedAddAttempts += unresolved;
      }
      toRemove.push({ ...key, action: 'remove' });
    }
    const requested = this.requestRecords(state, toRemove, undefined, { kind: 'retract', requestId }, at);
    receipt.addsSuperseded += requested.filter((record) => record.t === 'op-cancelled').length;
    receipt.removalsQueued = requested.filter((record) => record.t === 'requested').length;
    records.push(...requested);
    this.append(records);
    return receipt;
  }

  /** Release a held batch: queue its recorded release actions, explicitly. */
  release(batchId: string, by?: string): DiscordAwarenessReleaseReceipt {
    const state = this.load();
    const batch = state.batches.get(batchId);
    if (!batch) throw new Error(`Discord awareness batch not found: ${batchId}`);
    if (batch.status !== 'held' || !batch.held) {
      throw new Error(`Discord awareness batch ${batchId} is ${batch.status}, not held`);
    }
    const at = Date.now();
    const actions = batch.held.releaseActions;
    const records: JournalRecord[] = [{ t: 'released', at, batchId, ...(by ? { by } : {}) }];
    records.push(...this.requestRecords(state, actions.map((action) => ({ ...action })), batch.emoji, {
      kind: 'release',
      batchId,
    }, at));
    this.append(records);
    return {
      batchId,
      addsQueued: actions.filter((action) => action.action === 'add').length,
      removalsQueued: actions.filter((action) => action.action === 'remove').length,
    };
  }

  // -- delivery ---------------------------------------------------------------

  /**
   * The next dispatch for each reaction key that has work and nothing on the
   * wire. A key's operations go out in request order; consecutive requested
   * operations with the same action share one dispatch. An `unknown`
   * operation is retried only while it is still the newest live operation
   * for its key.
   */
  pendingDispatches(serverId?: string): DiscordAwarenessDispatch[] {
    const state = this.load();
    const byKey = new Map<string, DiscordAwarenessOp[]>();
    for (const op of state.ops.values()) {
      if (serverId !== undefined && op.key.serverId !== serverId) continue;
      const key = markKey(op.key);
      const list = byKey.get(key);
      if (list) list.push(op);
      else byKey.set(key, [op]);
    }
    const dispatches: Array<DiscordAwarenessDispatch & { order: number }> = [];
    for (const ops of byKey.values()) {
      // One request per reaction key on the wire at a time, including a
      // cancelled one still awaiting its outcome: opposite actions must not
      // overtake each other.
      if (ops.some((op) => op.attempts.at(-1)?.outcome === undefined && op.attempts.length > 0
        && this.inFlight.has(op.opId))) continue;
      const live = ops.filter((op) => !op.cancelled);
      let head: DiscordAwarenessOp | undefined;
      for (let index = 0; index < live.length; index++) {
        const op = live[index];
        const status = this.opStatus(op);
        if (status === 'requested') { head = op; break; }
        if (status === 'unknown' && index === live.length - 1) { head = op; break; }
      }
      if (!head) continue;
      const opIds = [head.opId];
      const start = live.indexOf(head);
      for (let index = start + 1; index < live.length; index++) {
        const next = live[index];
        if (next.action !== head.action || this.opStatus(next) !== 'requested') break;
        opIds.push(next.opId);
      }
      dispatches.push({ key: head.key, action: head.action, opIds, order: head.requestedAt });
    }
    return dispatches
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...dispatch }) => dispatch);
  }

  /** Write-ahead: record that a dispatch is about to leave the host. */
  recordDispatching(dispatch: DiscordAwarenessDispatch): Array<{ opId: string; attempt: number }> {
    const state = this.load();
    const at = Date.now();
    const dispatchId = randomUUID();
    const attempts = dispatch.opIds.map((opId) => {
      const op = state.ops.get(opId);
      if (!op) throw new Error(`Discord awareness operation not found: ${opId}`);
      return { opId, attempt: op.attempts.length + 1 };
    });
    this.append(attempts.map(({ opId, attempt }) => ({ t: 'dispatching' as const, at, opId, attempt, dispatchId })));
    for (const { opId } of attempts) this.inFlight.add(opId);
    return attempts;
  }

  /** Record the outcome of a dispatch's attempts. */
  recordOutcome(
    attempts: Array<{ opId: string; attempt: number }>,
    outcome: DiscordAwarenessOutcome,
    detail: { permanent?: boolean; error?: string } = {},
  ): void {
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

  view(): DiscordAwarenessBatchView[] {
    const state = this.load();
    const views: DiscordAwarenessBatchView[] = [];
    for (const batch of state.batches.values()) {
      if (batch.status === 'discarded') continue;
      const keys = new Set(batch.refs.map((ref) => markKey({ ...ref, emoji: batch.emoji })));
      const adds = emptyCounts();
      const removals = emptyCounts();
      const onKeys: DiscordAwarenessOp[] = [];
      for (const op of state.ops.values()) {
        if (!keys.has(markKey(op.key))) continue;
        onKeys.push(op);
        if (op.action === 'add' && op.cause.batchId === batch.id) adds[this.opStatus(op)]++;
        if (op.action === 'remove') removals[this.opStatus(op)]++;
      }
      const unresolvedAttempts = unresolvedDispatches(onKeys, (op, attempt) => this.attemptUnresolved(op, attempt));
      views.push({
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
        ...(batch.held
          ? { held: { reason: batch.held.reason, at: batch.held.at, releaseActions: batch.held.releaseActions.length } }
          : {}),
        ...(batch.cancelled ? { cancelled: batch.cancelled } : {}),
        ...(batch.released ? { released: batch.released } : {}),
        adds,
        removals,
        unresolvedAttempts,
      });
    }
    return views;
  }

  // -- internals --------------------------------------------------------------

  private opStatus(op: DiscordAwarenessOp): DiscordAwarenessOpStatus {
    const last = op.attempts.at(-1);
    // A confirmation is a fact about Discord, even for a request cancelled
    // while it was on the wire.
    if (last?.outcome === 'confirmed') return 'confirmed';
    if (op.cancelled) return 'cancelled';
    if (!last) return 'requested';
    if (last.outcome === undefined) return this.inFlight.has(op.opId) ? 'dispatching' : 'unknown';
    if (last.outcome === 'unknown') return 'unknown';
    if (last.outcome === 'not-sent') return 'requested';
    return last.permanent ? 'failed' : 'requested';
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
    const wanted = markKey(key);
    return [...state.ops.values()].filter((op) => markKey(op.key) === wanted);
  }

  /**
   * Records for new requests. A request supersedes requests for the same
   * key with the opposite action that were never sent (the newest explicit
   * intent wins without churning the reaction); operations already sent are
   * never touched.
   */
  private requestRecords(
    state: JournalState,
    requests: Array<DiscordAwarenessRef & { action: DiscordAwarenessAction; emoji?: string }>,
    emoji: string | undefined,
    cause: DiscordAwarenessOpCause,
    at: number,
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
      for (const op of this.opsForKey(state, key)) {
        if (op.action === request.action || superseded.has(op.opId)) continue;
        if (this.opStatus(op) !== 'requested' || op.attempts.some((attempt) => attempt.outcome !== 'not-sent')) continue;
        records.push({ t: 'op-cancelled', at, opId: op.opId, reason: 'superseded' });
        superseded.add(op.opId);
      }
      records.push({ t: 'requested', at, opId: randomUUID(), key, action: request.action, cause });
    }
    return records;
  }

  private load(): JournalState {
    const { records } = this.readJournal();
    const state = fold(records);
    const legacy = this.pendingLegacyImport(state);
    if (legacy?.records.length) return fold([...records, ...legacy.records]);
    return state;
  }

  /**
   * The journal's records, and how to repair an unterminated final line
   * before the next append: a torn fragment (never applied) is truncated
   * away; a complete record that only lost its newline is terminated.
   * Without the repair, the next append would share that line and turn a
   * harmless torn tail into corruption.
   */
  private readJournal(): { records: StoredRecord[]; repair?: { truncateTo: number } | { terminate: true } } {
    let raw: Buffer;
    try {
      raw = readFileSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [] };
      throw new Error(
        `Could not read Discord awareness journal ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const terminated = raw.length === 0 || raw[raw.length - 1] === 0x0a;
    const lastNewline = raw.lastIndexOf(0x0a);
    const body = terminated ? raw : raw.subarray(0, lastNewline + 1);
    const lines = body.toString('utf8').split('\n');
    const records: StoredRecord[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as StoredRecord);
      } catch {
        throw new Error(`Corrupt Discord awareness journal ${this.path} at line ${index + 1}`);
      }
    }
    if (terminated) return { records };
    const tail = raw.subarray(lastNewline + 1).toString('utf8');
    try {
      records.push(JSON.parse(tail) as StoredRecord);
      return { records, repair: { terminate: true } };
    } catch {
      // A torn append: none of it ever applied.
      return { records, repair: { truncateTo: lastNewline + 1 } };
    }
  }

  /**
   * A pre-journal ledger beside the journal: null when there is none;
   * otherwise its import records, empty when its hash is already imported
   * (a crash between the import and the rename), so the file is only renamed.
   */
  private pendingLegacyImport(state: JournalState): { records: JournalRecord[]; sha256: string } | null {
    let raw: string;
    try {
      raw = readFileSync(this.legacyPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(
        `Could not read Discord awareness ledger ${this.legacyPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (state.importedSources.has(sha256)) return { records: [], sha256 };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid Discord awareness ledger ${this.legacyPath}`);
    }
    return { records: importLegacy(parsed, this.legacyPath, sha256), sha256 };
  }

  private append(records: JournalRecord[]): void {
    if (records.length === 0) return;
    const journal = this.readJournal();
    const state = fold(journal.records);
    const legacy = this.pendingLegacyImport(state);
    const all: StoredRecord[] = legacy ? [...legacy.records, ...records] : records;
    let lines: StoredRecord[] = all;
    if (all.length > 1) {
      const txn = randomUUID();
      lines = [
        ...all.map((record) => ({ ...record, txn })),
        { t: 'commit', at: Date.now(), txn },
      ];
    }
    mkdirSync(dirname(this.path), { recursive: true });
    if (journal.repair && 'truncateTo' in journal.repair) truncateSync(this.path, journal.repair.truncateTo);
    const prefix = journal.repair && 'terminate' in journal.repair ? '\n' : '';
    const fd = openSync(this.path, 'a', 0o600);
    try {
      writeSync(fd, prefix + lines.map((record) => JSON.stringify(record)).join('\n') + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (legacy) this.retireLegacyFile();
  }

  private retireLegacyFile(): void {
    if (!existsSync(this.legacyPath)) return;
    try {
      renameSync(this.legacyPath, `${this.legacyPath}.migrated-v2`);
    } catch (error) {
      // The import is already recorded (by hash), so the file is inert; the
      // next write retries the rename.
      console.error(
        `[discord-awareness] imported ${basename(this.legacyPath)} but could not rename it: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Fold and legacy import
// ---------------------------------------------------------------------------

function fold(stored: StoredRecord[]): JournalState {
  const state: JournalState = { batches: new Map(), ops: new Map(), importedSources: new Set() };
  // Records of a transaction apply, in order, at its commit; an uncommitted
  // transaction (a torn or interrupted append) never applies.
  const open = new Map<string, JournalRecord[]>();
  const records: JournalRecord[] = [];
  for (const record of stored) {
    if (record.t === 'commit') {
      records.push(...(open.get(record.txn) ?? []));
      open.delete(record.txn);
    } else if (record.txn) {
      const buffered = open.get(record.txn);
      if (buffered) buffered.push(record);
      else open.set(record.txn, [record]);
    } else {
      records.push(record);
    }
  }
  for (const record of records) {
    switch (record.t) {
      case 'batch':
        if (!state.batches.has(record.batch.id)) {
          state.batches.set(record.batch.id, { ...structuredClone(record.batch), status: 'prepared' });
        }
        break;
      case 'activated': {
        const batch = state.batches.get(record.batchId);
        if (batch && batch.status !== 'discarded') batch.status = 'active';
        break;
      }
      case 'discarded': {
        const batch = state.batches.get(record.batchId);
        if (batch && batch.status === 'prepared') batch.status = 'discarded';
        break;
      }
      case 'held': {
        const batch = state.batches.get(record.batchId);
        if (batch && !batch.cancelled) {
          batch.status = 'held';
          batch.held = { reason: record.reason, at: record.at, releaseActions: structuredClone(record.releaseActions) };
        }
        break;
      }
      case 'released': {
        const batch = state.batches.get(record.batchId);
        if (batch && batch.status === 'held') {
          batch.status = 'active';
          delete batch.held;
          batch.released = { at: record.at, ...(record.by ? { by: record.by } : {}) };
        }
        break;
      }
      case 'cancelled': {
        const batch = state.batches.get(record.batchId);
        if (batch && !batch.cancelled) {
          if (batch.status === 'held') {
            batch.status = 'active';
            delete batch.held;
          }
          batch.cancelled = { at: record.at, ...(record.by ? { by: record.by } : {}) };
        }
        break;
      }
      case 'requested':
        if (!state.ops.has(record.opId)) {
          state.ops.set(record.opId, {
            opId: record.opId,
            key: { ...record.key },
            action: record.action,
            cause: { ...record.cause },
            requestedAt: record.at,
            attempts: [],
          });
        }
        break;
      case 'op-cancelled': {
        const op = state.ops.get(record.opId);
        if (op && !op.cancelled) op.cancelled = { at: record.at, reason: record.reason };
        break;
      }
      case 'dispatching': {
        const op = state.ops.get(record.opId);
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
      case 'import-complete':
        state.importedSources.add(record.sha256);
        break;
      default:
        break;
    }
  }
  return state;
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
 * Translate a version 1 or 2 ledger into journal records with deterministic
 * identities, ending with an `import-complete` record carrying the file's
 * hash. What the old ledger recorded is kept as it was recorded; nothing is
 * inferred about Discord. Pending work, and batches still prepared, are held
 * for an operator: they were queued before marks were an explicit choice.
 */
function importLegacy(parsed: unknown, path: string, sha256: string): JournalRecord[] {
  const document = parsed as { version?: unknown; batches?: unknown };
  if (!document || (document.version !== 1 && document.version !== 2) || !Array.isArray(document.batches)) {
    throw new Error(`Invalid Discord awareness ledger ${path}`);
  }
  const at = Date.now();
  const records: JournalRecord[] = [];
  for (const raw of document.batches as LegacyBatch[]) {
    if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.refs)) {
      throw new Error(`Invalid Discord awareness ledger ${path}`);
    }
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
    if (legacyActive) records.push({ t: 'activated', at: raw.createdAt, batchId: raw.id });
    const releaseActions: DiscordAwarenessReleaseAction[] = [];
    for (const entry of raw.refs) {
      const key = { serverId: entry.serverId, channelId: entry.channelId, messageId: entry.messageId, emoji: raw.emoji };
      // v1 entries carry no delivery state: an active v1 batch was all pending.
      const status = entry.deliveryStatus ?? (raw.status === 'pending' ? 'pending' : 'applied');
      const desired = entry.desired ?? raw.status === 'pending';
      if (!legacyActive || status === 'pending') {
        if (!legacyActive || desired || entry.markerPresent) {
          releaseActions.push({
            ...key,
            action: desired || !legacyActive ? 'add' : 'remove',
            ...(entry.attempts ? { priorAttempts: entry.attempts } : {}),
            ...(entry.lastError ? { priorError: entry.lastError } : {}),
          });
        }
        continue;
      }
      if (!entry.attempts || !entry.lastAction) continue;
      const opId = `v2:${raw.id}:${markKey(key)}`;
      const attemptAt = entry.lastAttemptAt ?? raw.createdAt;
      records.push({ t: 'requested', at: raw.createdAt, opId, key, action: entry.lastAction, cause: { kind: 'import', batchId: raw.id } });
      records.push({ t: 'dispatching', at: attemptAt, opId, attempt: 1 });
      records.push(status === 'applied'
        ? { t: 'outcome', at: attemptAt, opId, attempt: 1, outcome: 'confirmed' }
        : {
            t: 'outcome',
            at: attemptAt,
            opId,
            attempt: 1,
            outcome: 'failed',
            permanent: true,
            ...(entry.lastError ? { error: `recorded by an earlier ledger: ${entry.lastError}` } : {}),
          });
    }
    if (releaseActions.length > 0) {
      records.push({
        t: 'held',
        at,
        batchId: raw.id,
        reason: legacyActive
          ? 'queued by an earlier release, before marks were an explicit choice'
          : 'prepared by an earlier release, before marks were an explicit choice',
        releaseActions,
      });
    }
  }
  records.push({ t: 'import-complete', at, source: 'v2', sha256 });
  return records;
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

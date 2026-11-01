import { readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import { OperatorActionError } from '../operator-log.js';

/**
 * Discord awareness marks: a reaction (💤 by default) that an operator may
 * choose to place on Discord messages a surgery removed from a resident's
 * context, so the people who wrote them can see the resident no longer has
 * them in view.
 *
 * Marks are an explicit publication choice, separate from the surgery itself
 * (`DiscordAwarenessMarks`, default `none`). Once requested, they are
 * one-shot: branch moves and restarts never derive new requests from branch
 * state, and a restart never activates a surgery's marks. A batch a crash
 * left prepared is retired at startup, unsent, and the operator redoes the
 * surgery from its source to choose marks again (see recoverAtStartup).
 * Requests an activated batch owes go out with any delivery pass, a start's
 * included. What a restart does finish is an interrupted suppression's body,
 * on its own branch. An operator retracts or cancels explicitly. A version 2
 * ledger's batches are kept as history when it is rewritten as version 3,
 * and the work it had still to do is dropped, none of it sent, since nobody
 * chose it (see migrateLedger).
 *
 * The ledger is a table with one entry per reaction, keyed by (MCPL server
 * id, channel, message, emoji): what the acts that still stand want of it,
 * whether Discord is owed a request for that, and what Discord last
 * answered. It is never a model of what is on Discord: an answer is kept as
 * an answer, and a request never answered is kept as one that may land,
 * which nothing takes back. The server id is the configured route to a bot,
 * not the bot's identity: if the route is re-pointed at another bot, owed
 * requests act as that bot, and nothing here can detect it.
 *
 * Acts are ordered by the ledger's own counter (`moment`), never the clock:
 * a surgery's marks choice (its prepare), its activation and each retract
 * take the next moment. Between opposite wishes for one reaction the later
 * act wins, and an activation never revives a reaction that a retract made
 * after the surgery's choice decided against, even once that retract is
 * cancelled.
 *
 * One instance is the file's only writer: the running framework, or the
 * offline recovery while the host is stopped. It keeps the document in
 * memory, reads the file when it first needs it and again after a write
 * fails, and answers views from memory. Acts run one at a time, each written
 * before the next starts: compact JSON to a temporary file, synced, renamed
 * over the ledger, then the ledger's directory and its parent synced, by the
 * rule the framework's own recovery files follow (writeRecoveryFile). A
 * write that activates, completes or retires a batch syncs the store first,
 * so the ledger never outlives the branch state it relies on. A write that
 * throws has left the file as it was, and the act's change is dropped with
 * it; a directory that can't be synced after the rename is reported
 * (onUnsyncedWrite), and the write stands.
 */

export const DEFAULT_DISCORD_AWARENESS_EMOJI = '💤';

/**
 * Bound text that came from elsewhere (a Discord error body, a filesystem
 * error) before it is written to the ledger, logged or returned in a
 * receipt: the ledger keeps its entries for the store's life, and a server's
 * error text has no length limit of its own. Head and tail are kept, with
 * the omitted length stated; a cut never splits a surrogate pair.
 */
export function boundDiscordAwarenessText(text: string, max = 500): string {
  if (text.length <= max) return text;
  const tailLength = Math.min(100, Math.floor(max / 4));
  let head = text.slice(0, Math.max(0, max - tailLength - 40));
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
 * An operator's request the ledger won't carry out: an unknown batch or
 * retract request. Nothing was written. Any other error from an operator
 * control is a failure to read or write the ledger.
 */
export class DiscordAwarenessRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordAwarenessRefusal';
  }
}

/** Where a store's awareness ledger lives: the path every release used. */
export function defaultDiscordAwarenessOutboxPath(storePath: string): string {
  return join(storePath, 'recovery', 'discord-awareness-outbox.json');
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

/**
 * Where a batch is in its life:
 * - `prepared`: recorded before its surgery's body change, which settles it.
 *   One a crash leaves is retired at startup, never activated (see
 *   recoverAtStartup), except a suppression whose body a start on its branch
 *   finishes first. One an operator cancelled stays prepared, with
 *   `cancelled` set, and is never activated;
 * - `active`: activated by its surgery, or kept so from a version 2 ledger;
 * - `retired`: none of its marks will be sent: its surgery never happened or
 *   couldn't record its activation, a start found it left prepared, or a
 *   version 2 ledger never activated it.
 */
export type DiscordAwarenessBatchStatus = 'prepared' | 'active' | 'retired';

/** One surgery's marks choice, and a suppression's body to resume. */
export interface DiscordAwarenessBatch {
  id: string;
  status: DiscordAwarenessBatchStatus;
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  emoji: string;
  /** The clock when it was prepared: shown, never compared. */
  createdAt: number;
  /** The ledger moment of the surgery's marks choice (its prepare). */
  chosen: number;
  /** `none` for a suppression's batch with no marks; `legacy` for a version 2 ledger's. */
  scope: 'none' | DiscordAwarenessScope | 'legacy';
  /** The refs this batch requests marks on (authorized ∩ removed). */
  refs: DiscordAwarenessRef[];
  /** Removed addressable messages this batch leaves unmarked. */
  unmarked?: number;
  /** Authorized refs the surgery did not remove. */
  notRemoved?: number;
  /**
   * A suppression's removals, by message ids, which a start on its target
   * branch applies again while the batch is prepared: that branch being
   * active doesn't prove the redactions finished. The ids make each one
   * idempotent.
   */
  suppressionIntervals?: DiscordSuppressionInterval[];
  cancelled?: { at: number; by?: string };
  /**
   * A version 2 ledger's batch: how many of its refs agent-framework 0.22.x's
   * last attempt saw added (an add it recorded no error for), set when the
   * ledger was rewritten as version 3. It is history, never a claim about
   * what is on Discord now.
   */
  legacyAdded?: number;
}

/** A surgery's request, as it prepares a batch. */
export interface DiscordAwarenessPrepareInput {
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  refs: DiscordAwarenessRef[];
  scope: 'none' | DiscordAwarenessScope;
  emoji?: string;
  suppressionIntervals?: DiscordSuppressionInterval[];
  unmarked?: number;
  notRemoved?: number;
}

/** One retract request: removals of this bot's mark it made owed. */
interface LedgerRetract {
  /** What cancel takes. */
  id: string;
  /** The batch it retracted, or `all`. */
  target: string;
  at: number;
  by?: string;
  /** Its ledger moment. */
  moment: number;
  /** How many removals it queued. */
  keys: number;
  cancelled?: { at: number; by?: string };
}

/**
 * What the ledger will do with a batch whose body change has landed:
 * - `queued`: it is active, its requests owed;
 * - `not-scheduled`: none of its marks will be sent. It was retired, or it
 *   couldn't be, and stays prepared for the next start to retire, or it was
 *   never recorded; `error` says which, and why its activation failed.
 */
export type DiscordAwarenessSettlement =
  | { status: 'queued'; queued: number }
  | { status: 'not-scheduled'; error: string };

export type DiscordAwarenessOutcome = 'confirmed' | 'failed' | 'not-sent' | 'unknown';

/** A request Discord is owed for one reaction, or one claimed to send. */
export interface DiscordAwarenessRequest extends DiscordAwarenessRef {
  emoji: string;
  action: DiscordAwarenessAction;
  /** The moment of the act that owes it. */
  due: number;
}

/**
 * A reaction's state, as views and receipts count it:
 * - `queued`: a request is owed and not yet sent;
 * - `sending`: a request is on the wire;
 * - `present`, `absent`: nothing is owed, and that was Discord's last answer;
 * - `unknown`: nothing is owed, and the last request went unanswered;
 * - `failed`: what was owed ended unconfirmed: Discord refused it for good,
 *   or three attempts went unconfirmed;
 * - `untouched`: no request was ever answered or owed.
 */
export type DiscordAwarenessReactionState =
  | 'queued'
  | 'sending'
  | 'present'
  | 'absent'
  | 'unknown'
  | 'failed'
  | 'untouched';

/** Receipt for cancel(). Nothing is ever removed from Discord by a cancel. */
export interface DiscordAwarenessCancelReceipt {
  /** The batch id or retract request id that was cancelled. */
  target: string;
  kind: 'batch' | 'retract';
  /** Reactions this call left with nothing owed before any request for what
   *  the act wanted went out: for a batch not yet activated, every mark it
   *  would have requested. A repeated cancel stops none. */
  cancelled: number;
  /** The act's reactions whose last answer from Discord is what the act
   *  wanted (cancel undoes none of them). */
  confirmed: number;
  /** The act's reactions with a request on the wire or one never answered:
   *  any may land. */
  mayStillLand: number;
}

/** Receipt for retract(). */
export interface DiscordAwarenessRetractReceipt {
  requestId: string;
  /** Removals queued: one per selected reaction, whatever was answered before. */
  removalsQueued: number;
  /** Reactions whose owed add this removal replaced. An add on the wire
   *  still settles before the removal is sent, and may land
   *  (keysWithUnresolvedAdds). */
  addsSuperseded: number;
  /** Reactions with an add on the wire or one never answered: such an add
   *  may land after this removal. */
  keysWithUnresolvedAdds: number;
}

/** A version 2 ledger's batch whose undelivered work its rewrite as version
 *  3 dropped, none of it sent (see migrateLedger). */
export interface DiscordAwarenessImportedUnsent {
  batchId: string;
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  /** Marks agent-framework 0.22.x had still to add, and to remove. */
  adds: number;
  removals: number;
}

/** A batch startup retired (see recoverAtStartup), with what the operator
 *  needs to redo its surgery. */
export interface DiscordAwarenessRetirement {
  batchId: string;
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  /** The marks it would have requested, none of them sent: 0 for a batch
   *  with none, one an operator cancelled, or a version 2 ledger's, whose
   *  undelivered work its rewrite dropped and reported. */
  marks: number;
  /** Whether it is a suppression (it names removal intervals). */
  suppression: boolean;
  /** A version 2 ledger's batch: its marks stay as that ledger left them. */
  imported?: boolean;
}

/** Per-batch view for operators: what was asked and what is known. */
export interface DiscordAwarenessBatchView {
  kind: 'batch';
  id: string;
  status: DiscordAwarenessBatchStatus;
  scope: DiscordAwarenessBatch['scope'];
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  emoji: string;
  createdAt: number;
  refs: number;
  unmarked?: number;
  notRemoved?: number;
  cancelled?: { at: number; by?: string };
  /** Its refs' reactions, by state. */
  reactions: Record<DiscordAwarenessReactionState, number>;
  /** Its refs' reactions with a request on the wire or one never answered. */
  mayStillLand: number;
  /** A version 2 ledger's batch: refs 0.22.x's last attempt saw added
   *  (DiscordAwarenessBatch.legacyAdded). */
  legacyAdded?: number;
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
  /** Removals it queued. */
  keys: number;
  /** The reactions it still wants absent, by state. */
  reactions: Record<DiscordAwarenessReactionState, number>;
  /** Of those, the ones with a request on the wire or one never answered. */
  mayStillLand: number;
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
 * offline recovery. host/command's undo by messages takes the bare scope
 * words instead and refuses any other, and the recovery CLI parses its --marks.
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
// The ledger
// ---------------------------------------------------------------------------

/** One reaction's entry. */
interface LedgerEntry extends DiscordAwarenessRef {
  emoji: string;
  /** What the acts that still stand want of it: present (batches' marks) or
   *  absent (retracts' removals); null once each act that set it is cancelled. */
  wanted: 'present' | 'absent' | null;
  /** Those acts: batch ids for present, retract ids for absent. */
  wantedBy: string[];
  /** The moment of the latest retract that reached it, cancelled or not. */
  retracted?: number;
  /** The moment of the act that owes Discord a request now; null when nothing is owed. */
  due: number | null;
  /** Unconfirmed attempts (refused, or never answered) at what `due` owes. */
  attempts: number;
  /** The request written ahead and not yet answered, with the `due` it serves. */
  sending?: { action: DiscordAwarenessAction; due: number };
  /** Discord's last answer: present or absent, or unknown when the last
   *  request went unanswered. */
  confirmed?: 'present' | 'absent' | 'unknown';
  /** The actions of requests never answered: any may land or have landed,
   *  and nothing takes one out. */
  mayLand?: DiscordAwarenessAction[];
  /** What was owed ended unconfirmed (see countAttempt). */
  failed?: boolean;
}

interface LedgerDocument {
  version: 3;
  /** The last moment an act took. */
  moment: number;
  batches: DiscordAwarenessBatch[];
  retracts: LedgerRetract[];
  entries: LedgerEntry[];
}

/** The document, with its lookups. The maps hold the document's objects. */
interface LedgerState {
  doc: LedgerDocument;
  batches: Map<string, DiscordAwarenessBatch>;
  retracts: Map<string, LedgerRetract>;
  entries: Map<string, LedgerEntry>;
}

/**
 * Unconfirmed attempts (Discord refused it, or no answer came, so it may
 * have landed) at what one act owes, after which nothing more is sent for
 * it. An attempt refused before it left the host (`not-sent`) isn't
 * counted. Without a bound, a refusal Discord repeats, or a server that
 * never answers, would be sent again at every drain.
 */
const MAX_UNCONFIRMED_ATTEMPTS = 3;

/**
 * The durable awareness-mark ledger (see the module comment). Writing calls
 * are async and resolve once their write is on disk; each runs alone. Views
 * are synchronous, from memory: one made while a write is in progress sees
 * the act that write records.
 */
export class DiscordAwarenessOutbox {
  readonly path: string;
  private readonly store?: JsStore;
  /** Told what a version 2 ledger's rewrite drops, before it is written. */
  private readonly announceImport?: (unsent: DiscordAwarenessImportedUnsent[]) => void;
  /** Told of a directory that couldn't be synced after a write's rename. */
  private readonly onUnsyncedWrite: (directory: string, error: unknown) => void;
  /** The document, or null until it is read, and after a failed write
   *  whose file couldn't be read back: the next read tries again. */
  private state: LedgerState | null = null;
  /** The tail of the acts queued so far: each act starts after it. */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * @param path the ledger file (defaultDiscordAwarenessOutboxPath under a store).
   * @param opts.store the store whose branch state activations, completions
   *   and retirements rely on, synced before each is written.
   * @param opts.announceImport told, before a version 2 ledger is rewritten
   *   as version 3, which batches' undelivered work that drops, none of it sent.
   * @param opts.onUnsyncedWrite told of a directory that couldn't be synced
   *   after a write's rename: the write stands, though an operating system
   *   crash could lose it. Logged to stderr when not given.
   */
  constructor(
    path: string,
    opts: {
      store?: JsStore;
      announceImport?: (unsent: DiscordAwarenessImportedUnsent[]) => void;
      onUnsyncedWrite?: (directory: string, error: unknown) => void;
    } = {},
  ) {
    this.path = path;
    if (opts.store) this.store = opts.store;
    if (opts.announceImport) this.announceImport = opts.announceImport;
    this.onUnsyncedWrite = opts.onUnsyncedWrite ?? ((directory, error) => {
      console.error(`[discord-awareness] ${unsyncedWriteText(directory, path, error)}`);
    });
  }

  // -- surgery side -----------------------------------------------------------

  /**
   * Record a surgery's choice before its body change. Returns null when it
   * carries neither marks nor a suppression's removals. A prepared batch
   * never delivers: only its surgery's activate() does. If its write fails it
   * throws, saying what the ledger may hold (failedPrepare), and the surgery
   * doesn't run.
   */
  async prepare(input: DiscordAwarenessPrepareInput): Promise<DiscordAwarenessBatch | null> {
    const refs = dedupeRefs(input.refs);
    if (refs.length === 0 && !input.suppressionIntervals?.length) return null;
    return this.act(async (state) => {
      const batch: DiscordAwarenessBatch = {
        id: randomUUID(),
        status: 'prepared',
        agentName: input.agentName,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        emoji: input.emoji ?? DEFAULT_DISCORD_AWARENESS_EMOJI,
        createdAt: Date.now(),
        chosen: ++state.doc.moment,
        scope: input.scope,
        refs,
        ...(input.unmarked ? { unmarked: input.unmarked } : {}),
        ...(input.notRemoved ? { notRemoved: input.notRemoved } : {}),
        ...(input.suppressionIntervals?.length
          ? { suppressionIntervals: input.suppressionIntervals.map((interval) => ({ ...interval })) }
          : {}),
      };
      state.doc.batches.push(batch);
      state.batches.set(batch.id, batch);
      try {
        // On disk before the surgery's switch: if the surgery is interrupted,
        // a start finds the batch, retires it and alerts (recoverAtStartup),
        // and finishes a suppression's removals. A write that fails leaves
        // the file without it, so the surgery doesn't run.
        await this.persist(state);
      } catch (error) {
        throw new Error(`recording awareness batch ${batch.id} failed: ${errorText(error)}`, { cause: error });
      }
      return structuredClone(batch);
    });
  }

  /**
   * Activate a prepared batch after its body change landed: each of its
   * refs is wanted present, and a request is owed for it, on disk before
   * this returns. Activation completes the surgery's earlier choice; it is
   * not a new one, so a reaction a retract reached after that choice, even
   * one cancelled since, keeps what the retract decided. Returns how many
   * requests it made owed.
   */
  async activate(batchId: string): Promise<number> {
    return this.act((state) => this.activateIn(state, batchId));
  }

  private async activateIn(state: LedgerState, batchId: string): Promise<number> {
    const batch = state.batches.get(batchId);
    if (!batch) throw new Error(`Discord awareness batch not found: ${batchId}`);
    if (batch.status === 'active') return 0;
    if (batch.status !== 'prepared') throw new Error(`Discord awareness batch ${batchId} is ${batch.status}, not prepared`);
    // An operator cancelled it while its surgery was still running.
    if (batch.cancelled) throw new Error(`Discord awareness batch ${batchId} was cancelled before activation`);
    const moment = ++state.doc.moment;
    batch.status = 'active';
    let queued = 0;
    for (const ref of batch.refs) {
      const existing = state.entries.get(markKey(ref, batch.emoji));
      if (existing?.retracted !== undefined && existing.retracted > batch.chosen) continue;
      const entry = existing ?? addEntry(state, ref, batch.emoji);
      if (entry.wanted === 'present') {
        if (!entry.wantedBy.includes(batch.id)) entry.wantedBy.push(batch.id);
      } else {
        entry.wanted = 'present';
        entry.wantedBy = [batch.id];
      }
      owe(entry, moment);
      queued++;
    }
    // The activation asserts the body change just committed (the switch, or
    // the last redaction): the store is synced first, so a crash can never
    // leave marks owed for a change the store lost.
    await this.persist(state, { afterCommittedState: true });
    return queued;
  }

  /**
   * Activate a batch after its body change landed, and if that cannot be
   * recorded, retire it instead, so that what the caller reports is what
   * the ledger will do: `queued`, or `not-scheduled`. A batch that can be
   * neither activated nor retired stays prepared in the file, since a write
   * that fails leaves it as it was, and a start retires it, none of its
   * marks sent: the next start, or for a suppression the first start on its
   * branch, once it finds the removals applied. Never throws.
   */
  async settleActivation(batchId: string): Promise<DiscordAwarenessSettlement> {
    try {
      return await this.act(async (state) => {
        let detail: string;
        try {
          return { status: 'queued', queued: await this.activateIn(state, batchId) } as const;
        } catch (error) {
          detail = errorText(error);
        }
        // The file is as it was before the activation: the document read
        // back after a failed write (persist), or unchanged by a refusal.
        const batch = this.state?.batches.get(batchId);
        if (batch?.status === 'prepared') {
          try {
            await this.retireIn(this.state!, batchId);
          } catch (error) {
            return { status: 'not-scheduled', error: `${detail}; retiring it also failed (${errorText(error)}), so ${leftPrepared(batch)}` } as const;
          }
          return { status: 'not-scheduled', error: `${detail}; it is retired instead, none of its marks sent` } as const;
        } else if (!this.state) {
          return { status: 'not-scheduled', error: `${detail}; the ledger can't be read back, so ${leftPrepared()}` } as const;
        }
        return { status: 'not-scheduled', error: detail } as const;
      });
    } catch (error) {
      // The act never ran: the ledger can't be read.
      return { status: 'not-scheduled', error: `${errorText(error)}; ${leftPrepared()}` };
    }
  }

  /**
   * Retire a batch whose surgery did not complete. Only a prepared batch can
   * be retired; returns false when nothing was.
   */
  async discard(batchId: string): Promise<boolean> {
    return this.act(async (state) => {
      if (state.batches.get(batchId)?.status !== 'prepared') return false;
      await this.retireIn(state, batchId);
      return true;
    });
  }

  private async retireIn(state: LedgerState, batchId: string): Promise<void> {
    state.batches.get(batchId)!.status = 'retired';
    // Retiring a batch retires its obligations (marks and any body resume):
    // the branch state its surgery left (a restored source, or a completed
    // body) is synced first, so a crash can never keep the retirement while
    // losing the state it relies on.
    await this.persist(state, { afterCommittedState: true });
  }

  /**
   * The suppressions whose body a start on `branch` finishes: prepared
   * batches that name removal intervals, cancelled or not, whose target is
   * exactly that branch: a surgery's leftovers, or a version 2 ledger's that
   * agent-framework 0.22.x never activated. Branch ancestry is never
   * consulted. Throws when the ledger can't be read.
   */
  pendingSuppressionsFor(branch: string): DiscordAwarenessBatch[] {
    return this.loaded().doc.batches
      .filter((batch) => isPendingSuppression(batch) && batch.targetBranch === branch)
      .map((batch) => structuredClone(batch));
  }

  /**
   * Retire a suppression's batch once a start on its branch has finished
   * its removals, none of its marks sent: a restart never activates a
   * surgery's marks. `announceRetirement` is told before that is written,
   * for the reason recoverAtStartup's `announce` is. Nothing is written for
   * a batch that isn't prepared.
   */
  async completeSuppression(batchId: string, announceRetirement?: () => void): Promise<void> {
    return this.act(async (state) => {
      if (state.batches.get(batchId)?.status !== 'prepared') return;
      announceRetirement?.();
      // Certifies the redactions just made: written only after they are synced.
      await this.retireIn(state, batchId);
    });
  }

  /**
   * Startup reconciliation, run once before any delivery. It derives nothing
   * from branch ancestry, and it activates nothing:
   * - a request a previous process left on the wire is recorded unanswered
   *   (recordUnanswered): it may have reached Discord. It counts toward the
   *   bound like any unanswered attempt, and `givenUp` is how many reactions
   *   that brought there, which nothing more is sent for;
   * - a prepared batch, which an interrupted surgery left, or a failed one
   *   that couldn't retire it, is retired, none of its marks sent: the
   *   operator redoes the surgery from its source to choose marks again. A
   *   suppression whose body is pending is kept instead: a start on its
   *   branch finishes its removals and then retires it (completeSuppression).
   * Each retirement is reported in `retired`, and the store is synced before
   * any is written. `announce` is told what it retires and records
   * unanswered before that is written: each is written once, so a notice
   * given after the write would be lost for good if the process ended
   * between the two. If the write doesn't land, the next start says it
   * again.
   */
  async recoverAtStartup(
    announce?: (planned: { retired: DiscordAwarenessRetirement[]; unknownAttempts: number; givenUp: number }) => void,
  ): Promise<{ retired: DiscordAwarenessRetirement[]; unknownAttempts: number; givenUp: number }> {
    return this.act(async (state) => {
      let unknownAttempts = 0;
      let givenUp = 0;
      for (const entry of state.doc.entries) {
        if (!entry.sending) continue;
        unknownAttempts++;
        if (recordUnanswered(entry)) givenUp++;
      }
      const retired: DiscordAwarenessRetirement[] = [];
      for (const batch of state.doc.batches) {
        if (batch.status !== 'prepared' || isPendingSuppression(batch)) continue;
        batch.status = 'retired';
        retired.push({
          batchId: batch.id,
          agentName: batch.agentName,
          sourceBranch: batch.sourceBranch,
          targetBranch: batch.targetBranch,
          // A version 2 ledger's marks were reported when its rewrite dropped them.
          marks: !batch.cancelled && batch.scope !== 'legacy' ? batch.refs.length : 0,
          suppression: !!batch.suppressionIntervals?.length,
          ...(batch.scope === 'legacy' ? { imported: true } : {}),
        });
      }
      announce?.({ retired, unknownAttempts, givenUp });
      if (unknownAttempts > 0 || retired.length > 0) {
        await this.persist(state, { afterCommittedState: retired.length > 0 });
      }
      return { retired, unknownAttempts, givenUp };
    });
  }

  // -- operator controls ------------------------------------------------------

  /**
   * Stop a batch's marks, or a retract's removals (by its request id), from
   * being sent or sent again: the act is taken out of each reaction it
   * wants, and a reaction no act wants any more is owed nothing. A request
   * on the wire still has its answer recorded, before anything else goes for
   * that reaction. Nothing is ever removed from Discord by a cancel: the
   * receipt reports what may already have landed, and retract removes it.
   */
  async cancel(target: string, by?: string): Promise<DiscordAwarenessCancelReceipt> {
    return this.act(async (state) => {
      const retract = state.retracts.get(target);
      const batch = state.batches.get(target);
      if (!retract && !batch) {
        throw new DiscordAwarenessRefusal(
          `Discord awareness batch or retract request not found: ${target}; the marks list (listDiscordAwareness()) names them`,
        );
      }
      const kind = retract ? 'retract' : 'batch';
      const subject = (retract ?? batch)!;
      const wanted = retract ? 'absent' : 'present';
      // The reactions the act still wants: those no later act has taken
      // over. A prepared batch wants none yet, and a cancelled act none any
      // more.
      const reached = state.doc.entries.filter((entry) => entry.wantedBy.includes(target));
      const receipt: DiscordAwarenessCancelReceipt = {
        target,
        kind,
        cancelled: 0,
        confirmed: reached.filter((entry) => entry.confirmed === wanted).length,
        mayStillLand: reached.filter(mayStillLand).length,
      };
      // A repeated cancel finds nothing the act still wants, and writes nothing.
      if (subject.cancelled) return receipt;
      subject.cancelled = { at: Date.now(), ...(by ? { by } : {}) };
      if (batch?.status === 'prepared') {
        // Its surgery is still running, or it was left for a start to
        // retire: none of its marks was requested, and none will be.
        receipt.cancelled = batch.refs.length;
      } else {
        for (const entry of state.doc.entries) {
          const index = entry.wantedBy.indexOf(target);
          if (index < 0) continue;
          entry.wantedBy.splice(index, 1);
          if (entry.wantedBy.length > 0) continue;
          if (entry.due !== null && entry.attempts === 0 && entry.sending?.due !== entry.due) receipt.cancelled++;
          entry.wanted = null;
          entry.due = null;
          entry.attempts = 0;
        }
      }
      await this.persist(state);
      return receipt;
    });
  }

  /**
   * Remove this bot's mark (through the configured route) from a batch's
   * refs, or (`all`) from every ref of every batch not retired, whether
   * prepared or active, and every reaction the ledger holds. That covers
   * every mark a version 2 ledger recorded: one of its batches that
   * agent-framework 0.22.x activated stays active, and 0.22.x attempted only
   * an active batch's refs. A reaction is one per (route, message, emoji),
   * whichever batches asked for it, so this acts across batches. A removal
   * is owed for every selected reaction, whatever was answered before: an
   * answer can't establish what is on Discord now, and removing an absent
   * reaction does nothing. It is the latest act on those reactions: an add
   * owed there is replaced, and a batch whose choice came before it, once
   * activated, leaves them as this decides. The receipt reports the adds
   * that may still land.
   */
  async retract(target: string | 'all', by?: string): Promise<DiscordAwarenessRetractReceipt> {
    return this.act(async (state) => {
      const keys = new Map<string, DiscordAwarenessRef & { emoji: string }>();
      const select = (ref: DiscordAwarenessRef, emoji: string) => {
        keys.set(markKey(ref, emoji), {
          serverId: ref.serverId,
          channelId: ref.channelId,
          messageId: ref.messageId,
          emoji,
        });
      };
      if (target === 'all') {
        for (const batch of state.doc.batches) {
          if (batch.status === 'retired') continue;
          for (const ref of batch.refs) select(ref, batch.emoji);
        }
        for (const entry of state.doc.entries) select(entry, entry.emoji);
      } else {
        const batch = state.batches.get(target);
        if (!batch) {
          throw new DiscordAwarenessRefusal(
            `Discord awareness batch not found: ${target}; the marks list (listDiscordAwareness()) names them, or retract all`,
          );
        }
        for (const ref of batch.refs) select(ref, batch.emoji);
      }
      const retract: LedgerRetract = {
        id: randomUUID(),
        target,
        at: Date.now(),
        ...(by ? { by } : {}),
        moment: ++state.doc.moment,
        keys: keys.size,
      };
      const receipt: DiscordAwarenessRetractReceipt = {
        requestId: retract.id,
        removalsQueued: keys.size,
        addsSuperseded: 0,
        keysWithUnresolvedAdds: 0,
      };
      for (const [key, ref] of keys) {
        const entry = state.entries.get(key) ?? addEntry(state, ref, ref.emoji);
        if (entry.wanted === 'present' && entry.due !== null) receipt.addsSuperseded++;
        if (entry.sending?.action === 'add' || entry.mayLand?.includes('add')) receipt.keysWithUnresolvedAdds++;
        entry.retracted = retract.moment;
        if (entry.wanted === 'absent') entry.wantedBy.push(retract.id);
        else {
          entry.wanted = 'absent';
          entry.wantedBy = [retract.id];
        }
        owe(entry, retract.moment);
      }
      state.doc.retracts.push(retract);
      state.retracts.set(retract.id, retract);
      await this.persist(state);
      return receipt;
    });
  }

  // -- delivery ---------------------------------------------------------------

  /**
   * The requests owed and not on the wire, oldest act first, for one server
   * or every one. Throws when the ledger can't be read.
   */
  due(serverId?: string): DiscordAwarenessRequest[] {
    return owedRequests(this.loaded(), serverId);
  }

  /**
   * Choose a server's next owed request and write it ahead, in one act:
   * what is owed is read as the ledger holds it now, so a cancel or retract
   * made while an earlier request was on the wire is never overridden by an
   * older list. A reaction with a request on the wire is never chosen again
   * until its answer is written. `skip` excludes requests already tried in
   * this pass. Resolves once the write-ahead is on disk, with the request to
   * send, or null when nothing is owed.
   *
   * A delivery pass claims only once its last request's answer is written,
   * so a request of this server still marked on the wire here is one whose
   * answer couldn't be written. It is recorded as unanswered first, as a
   * start records one an earlier process left: it may land, and what it
   * served is owed again.
   */
  async claim(
    serverId: string,
    skip: (request: DiscordAwarenessRequest) => boolean = () => false,
  ): Promise<DiscordAwarenessRequest | null> {
    return this.act(async (state) => {
      let released = false;
      for (const entry of state.doc.entries) {
        if (entry.sending && entry.serverId === serverId) {
          recordUnanswered(entry);
          released = true;
        }
      }
      const request = owedRequests(state, serverId).find((candidate) => !skip(candidate));
      if (!request) {
        if (released) await this.persist(state);
        return null;
      }
      const entry = state.entries.get(markKey(request, request.emoji))!;
      entry.sending = { action: request.action, due: request.due };
      await this.persist(state);
      return request;
    });
  }

  /**
   * Record a claimed request's answer. An answer ends what is owed only if
   * it is for the act its request served: one for an older act updates what
   * Discord last answered, and what may land, alone, so an act made while a
   * request was out still gets its own request. Resolves to whether this
   * ended what is owed without a confirmation (refused for good, or at the
   * third unconfirmed attempt), so nothing more is sent for it.
   */
  async recordOutcome(
    request: DiscordAwarenessRequest,
    outcome: DiscordAwarenessOutcome,
    detail: { permanent?: boolean } = {},
  ): Promise<boolean> {
    return this.act(async (state) => {
      const entry = state.entries.get(markKey(request, request.emoji));
      if (!entry?.sending || entry.sending.due !== request.due || entry.sending.action !== request.action) {
        throw new Error(
          `No ${request.action} for ${request.channelId}/${request.messageId} is on the wire to record an answer for`,
        );
      }
      let ended = false;
      if (outcome === 'confirmed') {
        delete entry.sending;
        entry.confirmed = request.action === 'add' ? 'present' : 'absent';
        if (request.due === entry.due) {
          entry.due = null;
          entry.attempts = 0;
        }
      } else if (outcome === 'unknown') {
        ended = recordUnanswered(entry);
      } else {
        delete entry.sending;
        // A request refused before it left the host isn't an attempt.
        if (outcome === 'failed') ended = countAttempt(entry, request.due, detail.permanent === true);
      }
      await this.persist(state);
      return ended;
    });
  }

  // -- views ------------------------------------------------------------------

  batches(): DiscordAwarenessBatch[] {
    return this.loaded().doc.batches.map((batch) => structuredClone(batch));
  }

  view(): DiscordAwarenessView[] {
    const state = this.loaded();
    const views: DiscordAwarenessView[] = [];
    for (const batch of state.doc.batches) {
      if (batch.status === 'retired') continue;
      const reactions = emptyCounts();
      let landing = 0;
      for (const ref of batch.refs) {
        const entry = state.entries.get(markKey(ref, batch.emoji));
        reactions[reactionState(entry)]++;
        if (entry && mayStillLand(entry)) landing++;
      }
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
        ...(batch.cancelled ? { cancelled: { ...batch.cancelled } } : {}),
        reactions,
        mayStillLand: landing,
        ...(batch.legacyAdded !== undefined ? { legacyAdded: batch.legacyAdded } : {}),
      });
    }
    for (const retract of state.doc.retracts) {
      const reactions = emptyCounts();
      let landing = 0;
      for (const entry of state.doc.entries) {
        if (!entry.wantedBy.includes(retract.id)) continue;
        reactions[reactionState(entry)]++;
        if (mayStillLand(entry)) landing++;
      }
      views.push({
        kind: 'retract',
        id: retract.id,
        target: retract.target,
        at: retract.at,
        ...(retract.by ? { by: retract.by } : {}),
        ...(retract.cancelled ? { cancelled: { ...retract.cancelled } } : {}),
        keys: retract.keys,
        reactions,
        mayStillLand: landing,
      });
    }
    return views;
  }

  // -- internals --------------------------------------------------------------

  /**
   * Run one act after every act queued before it, on the document as it is
   * then (read first if it isn't held). A version 2 ledger is rewritten as
   * version 3 by the first act, before the act's own change.
   */
  private act<T>(fn: (state: LedgerState) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const state = this.state ?? await this.open();
      try {
        return await fn(state);
      } catch (error) {
        // An act that throws has left the file as it was, so whatever it
        // changed in memory goes too: the document is read back.
        this.forget();
        throw error;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Drop the document held in memory and read the file back; if it can't
   *  be read, the next read tries again. */
  private forget(): void {
    this.state = null;
    try {
      this.loaded();
    } catch { /* unread: the next read tries again */ }
  }

  /**
   * Read the ledger for an act. A version 2 ledger is rewritten as version
   * 3 (migrateLedger), the work it drops announced before the write; the
   * rewritten document is held only once its write is on disk.
   */
  private async open(): Promise<LedgerState> {
    const read = readLedger(this.path);
    if (read.version === 3) return (this.state = read.state);
    const { state, unsent } = migrateLedger(read.document);
    // Said before it's written: the rewrite is made once, so a notice given
    // after it would be lost for good if the process ended between the two.
    // If the write doesn't land, the next act says it again.
    if (unsent.length > 0) {
      console.error(
        `[discord-awareness] rewriting ${this.path} as version 3: ${unsent.length} batch(es) had marks ` +
          'agent-framework 0.22.x had still to add or remove, and none of them will be sent, since nobody chose them: ' +
          unsent.map((batch) => `batch ${batch.batchId} (${batch.agentName}, ${batch.sourceBranch} to ` +
            `${batch.targetBranch}): ${batch.adds} to add, ${batch.removals} to remove`).join('; ') +
          '. A batch 0.22.x never activated placed no marks; retracting a batch takes off the mark of its emoji ' +
          'from each of its messages, whichever batch placed it',
      );
      this.announceImport?.(unsent);
    }
    await writeLedgerFile(this.path, state.doc, this.onUnsyncedWrite);
    return (this.state = state);
  }

  /**
   * The document for a view: as held, or read now. A version 2 ledger is
   * refused here: only an act rewrites it.
   */
  private loaded(): LedgerState {
    if (this.state) return this.state;
    const read = readLedger(this.path);
    if (read.version !== 3) {
      throw new Error(
        `Discord awareness ledger ${this.path} is version 2, which its first write rewrites as version 3, at a ` +
          'start or an offline recovery; nothing is read from it before that',
      );
    }
    return (this.state = read.state);
  }

  /**
   * Write the document. A write that throws has left the file as it was, so
   * the act's change, already made in memory, is dropped: the document is
   * read back from the file, and if it can't be read, the next read tries
   * again. `afterCommittedState` syncs the store first.
   */
  private async persist(state: LedgerState, opts: { afterCommittedState?: boolean } = {}): Promise<void> {
    try {
      if (opts.afterCommittedState) this.store?.sync();
      await writeLedgerFile(this.path, state.doc, this.onUnsyncedWrite);
    } catch (error) {
      this.forget();
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function addEntry(state: LedgerState, ref: DiscordAwarenessRef, emoji: string): LedgerEntry {
  const entry: LedgerEntry = {
    serverId: ref.serverId,
    channelId: ref.channelId,
    messageId: ref.messageId,
    emoji,
    wanted: null,
    wantedBy: [],
    due: null,
    attempts: 0,
  };
  state.doc.entries.push(entry);
  state.entries.set(markKey(ref, emoji), entry);
  return entry;
}

/** An act at `moment` owes Discord a request, whatever was answered before. */
function owe(entry: LedgerEntry, moment: number): void {
  entry.due = moment;
  entry.attempts = 0;
  delete entry.failed;
}

/**
 * The request on the wire for this entry went unanswered: its action may
 * land, or have landed, and what Discord holds is unknown. It counts toward
 * the bound if it served what is owed now. This is the one place both an
 * answer the connection couldn't get and a request a previous process left
 * on the wire (recoverAtStartup) are recorded. Returns whether that ended
 * what is owed.
 */
function recordUnanswered(entry: LedgerEntry): boolean {
  const sent = entry.sending!;
  delete entry.sending;
  const mayLand = entry.mayLand ?? [];
  if (!mayLand.includes(sent.action)) mayLand.push(sent.action);
  entry.mayLand = mayLand;
  entry.confirmed = 'unknown';
  return countAttempt(entry, sent.due, false);
}

/**
 * Count an unconfirmed attempt at what `due` owed. Only an attempt at what
 * is owed now counts: one for an older act changes nothing owed. Discord's
 * refusal for good, or the bound, ends what is owed: nothing more is sent
 * for it, and the entry is `failed` until a new act owes a request.
 * Returns whether it ended.
 */
function countAttempt(entry: LedgerEntry, due: number, permanent: boolean): boolean {
  if (due !== entry.due) return false;
  entry.attempts++;
  if (!permanent && entry.attempts < MAX_UNCONFIRMED_ATTEMPTS) return false;
  entry.due = null;
  entry.failed = true;
  return true;
}

function mayStillLand(entry: LedgerEntry): boolean {
  return !!entry.sending || !!entry.mayLand?.length;
}

function reactionState(entry: LedgerEntry | undefined): DiscordAwarenessReactionState {
  if (!entry) return 'untouched';
  if (entry.sending) return 'sending';
  if (entry.due !== null) return 'queued';
  if (entry.failed) return 'failed';
  return entry.confirmed ?? 'untouched';
}

/** The requests owed and not on the wire, oldest act first, then in the
 *  order the ledger first held their reactions. */
function owedRequests(state: LedgerState, serverId?: string): DiscordAwarenessRequest[] {
  const owed: DiscordAwarenessRequest[] = [];
  for (const entry of state.doc.entries) {
    if (entry.due === null || entry.sending || entry.wanted === null) continue;
    if (serverId !== undefined && entry.serverId !== serverId) continue;
    owed.push({
      serverId: entry.serverId,
      channelId: entry.channelId,
      messageId: entry.messageId,
      emoji: entry.emoji,
      action: entry.wanted === 'present' ? 'add' : 'remove',
      due: entry.due,
    });
  }
  // A stable sort: reactions owed by one act keep the ledger's order.
  return owed.sort((a, b) => a.due - b.due);
}

/** Requests a batch's activation made owed that are still owed. */
function emptyCounts(): Record<DiscordAwarenessReactionState, number> {
  return { queued: 0, sending: 0, present: 0, absent: 0, unknown: 0, failed: 0, untouched: 0 };
}

/**
 * A suppression whose body may still need applying on its target branch: a
 * prepared batch that names removal intervals. Its surgery's activation
 * means the body completed, and a retired batch is never resumed: its
 * surgery gave the body up after putting the source back, or
 * completeSuppression retired it once a start finished its body. A version
 * 2 ledger's batch that 0.22.x activated is taken as finished, as 0.22.x
 * took it.
 */
function isPendingSuppression(batch: DiscordAwarenessBatch): boolean {
  return batch.status === 'prepared' && !!batch.suppressionIntervals?.length;
}

function errorText(error: unknown): string {
  return boundDiscordAwarenessText(error instanceof Error ? error.message : String(error));
}

/** What becomes of a batch left prepared after its surgery's body landed:
 *  none of its marks is ever sent. */
function leftPrepared(batch?: DiscordAwarenessBatch): string {
  if (!batch) return 'it stays prepared, and a start that can read the ledger retires it, none of its marks sent';
  return batch.suppressionIntervals?.length
    ? `it stays prepared, and the first start on ${batch.targetBranch} finds its removals applied and retires it, none of its marks sent`
    : 'it stays prepared, and the next start retires it, none of its marks sent';
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/**
 * Read and check the ledger file: a missing file is an empty ledger. A file
 * this build can't read for its meaning is refused, never guessed at: one
 * it can't read or parse, one that isn't the shape its version promises,
 * and any version but 2 and 3.
 */
function readLedger(path: string):
  | { version: 3; state: LedgerState }
  | { version: 2; document: { version: 2; batches: unknown[] } } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 3, state: indexed({ version: 3, moment: 0, batches: [], retracts: [], entries: [] }) };
    }
    throw new Error(`Could not read Discord awareness ledger ${path}: ${errorText(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid Discord awareness ledger ${path}: it isn't JSON`);
  }
  const version = !!parsed && typeof parsed === 'object' ? (parsed as { version?: unknown }).version : undefined;
  if (version === 3) {
    if (!isLedgerDocument(parsed)) throw new Error(`Invalid Discord awareness ledger ${path}`);
    return { version: 3, state: indexed(parsed) };
  }
  if (version === 2) {
    // A ledger the released readers would have refused is refused here too,
    // never read for a meaning: a malformed field (`activationPolicy:
    // 'explicit '`) would otherwise retire a suppression whose removals a
    // start on its branch still owes.
    if (!isLegacyLedger(parsed)) throw new Error(`Invalid Discord awareness ledger ${path}`);
    return { version: 2, document: parsed as { version: 2; batches: unknown[] } };
  }
  throw new Error(
    `Discord awareness ledger ${path} is ${version === undefined ? 'of no version' : `version ${JSON.stringify(version)}`}, ` +
      'which this build can\'t read: it reads versions 2 and 3',
  );
}

function indexed(doc: LedgerDocument): LedgerState {
  return {
    doc,
    batches: new Map(doc.batches.map((batch) => [batch.id, batch])),
    retracts: new Map(doc.retracts.map((retract) => [retract.id, retract])),
    entries: new Map(doc.entries.map((entry) => [markKey(entry, entry.emoji), entry])),
  };
}

/**
 * Write the document: compact JSON to a temporary file beside the ledger,
 * synced, renamed over it, then its directory synced, for the ledger's entry
 * in it, and that directory's parent, for the directory's own entry, which
 * is new when a write, this one or an earlier one, had to make it. This is
 * the framework's writeRecoveryFile rule. A failure before the rename removes
 * the temporary file and throws, leaving the ledger as it was. A directory
 * that can't be synced after it is reported, and the write stands: the new
 * ledger is in place, though an operating system crash could lose it.
 * Serialized before the first await, so the text is the document as the act
 * left it.
 */
async function writeLedgerFile(
  path: string,
  doc: LedgerDocument,
  onUnsynced: (directory: string, error: unknown) => void,
): Promise<void> {
  const text = `${JSON.stringify(doc)}\n`;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'w', 0o600);
    try {
      await file.writeFile(text, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  for (const synced of [directory, dirname(directory)]) {
    try {
      await syncDirectory(synced);
    } catch (error) {
      try {
        onUnsynced(synced, error);
      } catch { /* the write stands: a report that fails changes nothing in the file */ }
    }
  }
}

/**
 * Sync a directory, so its entries reach the disk, as the framework's
 * syncRecoveryDirectory does: not on win32, where a directory can't be
 * opened, and a sync refused with EINVAL or EBADF, the answer where the
 * filesystem can't sync a directory, is let go, since it would come again on
 * every write. Any other failure throws, for the write to report.
 */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'EBADF') throw error;
  } finally {
    await handle.close();
  }
}

/** The report of a directory that couldn't be synced, in the words of the
 *  framework's recovery-sync alert. */
export function unsyncedWriteText(directory: string, path: string, error: unknown): string {
  return `syncing ${directory} failed, so ${path} may not survive a crash: ${errorText(error)}`;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isOptional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const isRefShape = (value: unknown): boolean => isRecord(value)
  && isString(value.serverId) && isString(value.channelId) && isString(value.messageId);
const isAction = (value: unknown): boolean => value === 'add' || value === 'remove';
const isCancelled = (value: unknown): boolean => isRecord(value) && isNumber(value.at) && isOptional(value.by, isString);
const isInterval = (value: unknown): boolean => isRecord(value) && isString(value.fromId) && isString(value.toId);

/** Whether a parsed version 3 document has the shape this build writes. */
function isLedgerDocument(value: unknown): value is LedgerDocument {
  if (!isRecord(value) || value.version !== 3 || !isNumber(value.moment)) return false;
  const { batches, retracts, entries } = value;
  return Array.isArray(batches) && batches.every((batch) => isRecord(batch)
      && isString(batch.id)
      && (batch.status === 'prepared' || batch.status === 'active' || batch.status === 'retired')
      && isString(batch.agentName) && isString(batch.sourceBranch) && isString(batch.targetBranch)
      && isString(batch.emoji) && isNumber(batch.createdAt) && isNumber(batch.chosen)
      && (batch.scope === 'none' || batch.scope === 'addressed' || batch.scope === 'all' || batch.scope === 'legacy')
      && Array.isArray(batch.refs) && batch.refs.every(isRefShape)
      && isOptional(batch.unmarked, isNumber) && isOptional(batch.notRemoved, isNumber)
      && isOptional(batch.suppressionIntervals, (intervals) => Array.isArray(intervals) && intervals.every(isInterval))
      && isOptional(batch.cancelled, isCancelled) && isOptional(batch.legacyAdded, isNumber))
    && Array.isArray(retracts) && retracts.every((retract) => isRecord(retract)
      && isString(retract.id) && isString(retract.target) && isNumber(retract.at)
      && isOptional(retract.by, isString) && isNumber(retract.moment) && isNumber(retract.keys)
      && isOptional(retract.cancelled, isCancelled))
    && Array.isArray(entries) && entries.every((entry) => isRefShape(entry) && isRecord(entry)
      && isString(entry.emoji)
      && (entry.wanted === 'present' || entry.wanted === 'absent' || entry.wanted === null)
      && Array.isArray(entry.wantedBy) && entry.wantedBy.every(isString)
      && isOptional(entry.retracted, isNumber)
      && (entry.due === null || isNumber(entry.due)) && isNumber(entry.attempts)
      && isOptional(entry.sending, (sending) => isRecord(sending) && isAction(sending.action) && isNumber(sending.due))
      && isOptional(entry.confirmed, (confirmed) => confirmed === 'present' || confirmed === 'absent' || confirmed === 'unknown')
      && isOptional(entry.mayLand, (mayLand) => Array.isArray(mayLand) && mayLand.every(isAction))
      && isOptional(entry.failed, (failed) => typeof failed === 'boolean'));
}

// ---------------------------------------------------------------------------
// Version 2
// ---------------------------------------------------------------------------

interface LegacyEntry extends DiscordAwarenessRef {
  desired: boolean;
  markerPresent: boolean;
  deliveryStatus: 'pending' | 'applied' | 'permanent-failure';
  attempts: number;
  lastAction?: DiscordAwarenessAction;
  lastAttemptAt?: number;
  lastError?: string;
}

interface LegacyBatch {
  id: string;
  status: 'prepared' | 'active';
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
 * Whether a parsed ledger is a version 2 ledger the released readers
 * accepted (every release with the outbox, 0.6.7 to 0.22.3, checked these
 * fields alike): batches `prepared` or `active`, with an activation policy
 * and suppression intervals of the shapes they wrote, and refs that are
 * full entries.
 */
function isLegacyLedger(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.batches)) return false;
  return value.batches.every((batch) => isRecord(batch)
    && isString(batch.id)
    && (batch.status === 'prepared' || batch.status === 'active')
    && isString(batch.agentName) && isString(batch.sourceBranch) && isString(batch.targetBranch)
    && isString(batch.emoji) && typeof batch.createdAt === 'number'
    && Array.isArray(batch.refs)
    && (batch.activationPolicy === undefined || batch.activationPolicy === 'target-branch'
      || batch.activationPolicy === 'explicit')
    && isOptional(batch.suppressionIntervals, (intervals) => Array.isArray(intervals) && intervals.every(isInterval))
    && batch.refs.every(isLegacyEntry));
}

/** Whether a version 2 ledger's ref is an entry as the released readers required it. */
function isLegacyEntry(value: unknown): boolean {
  return isRefShape(value) && isRecord(value)
    && typeof value.desired === 'boolean'
    && typeof value.markerPresent === 'boolean'
    && (value.deliveryStatus === 'pending' || value.deliveryStatus === 'applied'
      || value.deliveryStatus === 'permanent-failure')
    && typeof value.attempts === 'number'
    && (value.lastAction === undefined || isAction(value.lastAction))
    && (value.lastAttemptAt === undefined || typeof value.lastAttemptAt === 'number')
    && (value.lastError === undefined || typeof value.lastError === 'string');
}

/**
 * Rewrite a version 2 ledger as version 3. Batches keep their ids, take
 * scope `legacy`, and keep, of what the old ledger recorded about each ref's
 * attempts, only how many refs the last attempt saw added (`legacyAdded`):
 * never a judgment about what is on Discord. No entries are made: a retract
 * of a batch reaches its refs, and one of `all` the refs of every batch it
 * activated, the only ones 0.22.x marked. The work the old ledger had
 * still to do (its pending adds and removals, and every mark of a batch it
 * never activated) is dropped, none of it sent, and returned in `unsent`:
 * it was queued before marks were an explicit choice, so nobody chose it. A
 * batch it activated stays active. One it never activated is retired,
 * except a suppression whose body may be pending on its branch, which stays
 * prepared, as an interrupted surgery's does, for a start on that branch to
 * finish and retire (see pendingSuppressionsFor). A second listing of a
 * batch id is skipped.
 */
function migrateLedger(
  document: { version: 2; batches: unknown[] },
): { state: LedgerState; unsent: DiscordAwarenessImportedUnsent[] } {
  const doc: LedgerDocument = { version: 3, moment: 0, batches: [], retracts: [], entries: [] };
  const unsent: DiscordAwarenessImportedUnsent[] = [];
  const seen = new Set<string>();
  for (const raw of document.batches as LegacyBatch[]) {
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    const legacyActive = raw.status === 'active';
    const pendingBody = raw.activationPolicy === 'explicit' && !!raw.suppressionIntervals?.length;
    doc.batches.push({
      id: raw.id,
      status: legacyActive ? 'active' : pendingBody ? 'prepared' : 'retired',
      agentName: raw.agentName,
      sourceBranch: raw.sourceBranch,
      targetBranch: raw.targetBranch,
      emoji: raw.emoji,
      createdAt: raw.createdAt,
      chosen: ++doc.moment,
      scope: 'legacy',
      refs: dedupeRefs(raw.refs),
      ...(raw.suppressionIntervals?.length
        ? { suppressionIntervals: raw.suppressionIntervals.map((interval) => ({ fromId: interval.fromId, toId: interval.toId })) }
        : {}),
      // Only `lastError` speaks to the last attempt's outcome: the old
      // writer cleared it on success and set it on failure, and nothing else
      // touched it. `deliveryStatus` was its reconciliation state, rewritten
      // by branch switches without any request.
      legacyAdded: new Set(raw.refs
        .filter((entry) => !!entry.attempts && entry.lastAction === 'add' && entry.lastError === undefined)
        .map((entry) => refKey(entry))).size,
    });
    let adds = 0;
    let removals = 0;
    const counted = new Set<string>();
    for (const entry of raw.refs) {
      // A ref listed twice is one ref.
      if (counted.has(refKey(entry))) continue;
      counted.add(refKey(entry));
      // What 0.22.x had still to do for this ref, dropped here.
      if ((!legacyActive || entry.deliveryStatus === 'pending') && (!legacyActive || entry.desired || entry.markerPresent)) {
        if (entry.desired || !legacyActive) adds++;
        else removals++;
      }
    }
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
  return { state: indexed(doc), unsent };
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

/** The Discord channel id a ref's channel names: its last part, when it's
 *  spelled `discord:<guild>:<channel>`. Delivery sends it, and keys use it. */
export function discordChannelOf(channelId: string): string {
  return channelId.startsWith('discord:') ? channelId.split(':').at(-1)! : channelId;
}

/** A ref's key, by its channel's Discord id, so one channel spelled two ways
 *  is one channel. */
function refKey(ref: DiscordAwarenessRef): string {
  return `${ref.serverId}\0${discordChannelOf(ref.channelId)}\0${ref.messageId}`;
}

function markKey(ref: DiscordAwarenessRef, emoji: string): string {
  return `${emoji}\0${refKey(ref)}`;
}

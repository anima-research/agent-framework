/**
 * TuneOutCoordinator (issue #77) — the host-side machinery between a
 * tuned-out channel and the subconscious resident.
 *
 * Responsibilities: classify diverted traffic (stamp everything, wake on
 * addressed), acknowledge suppressed mentions deterministically, run the
 * per-channel summary cadence, count wakes durably with max-wakes
 * auto-cancel, and deliver the cancel dump.
 *
 * Voice doctrine ("no words in models' mouths"): everything the resident
 * reads from the subconscious is the subconscious's verbatim text under its
 * own participant name. Host-authored framing is system-styled and never
 * voiced: `<tuned-out-backlog …>` wraps raw diverted messages (the
 * <backscroll> precedent), and `[Tune-out: …]` bracket notices carry
 * lifecycle facts (the [Gate: …] precedent).
 */

import { NOTICE_TAG } from '../notice-tags.js';
import { cutToFit, quotedValue, suppliedValue } from '../supplied-text.js';
import { randomUUID } from 'node:crypto';
import { authorLine, authorNamed, beginsWithAuthorLine } from '../author-presentation.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { StoredMessage } from '@animalabs/context-manager';
import { qualifiedChannelName, type ChannelRef, type ChannelRegistry, type TuneOutParams } from '../mcpl/channel-registry.js';
import type { McplServerRegistry } from '../mcpl/server-registry.js';
import { CapabilityGrant } from '../mcpl/capability-grant.js';
import { armAfter, armAt } from '../deadline-timer.js';
import type { TraceEventInput } from '../types/trace.js';

/** The options a tune-out call can give. */
type TuneOutOption = 'durationSeconds' | 'cadenceSeconds' | 'backlogCap' | 'maxWakes';

/** A hold asked for with no reader to watch it: there is none (a reader ended, or none was configured). */
const NO_READER_REFUSAL = "Nothing was tuned out: no reader is configured here to read a held channel, and this host doesn't "
  + "hold one without a reader, so tune_out isn't available here, and calling it again won't change that. If "
  + 'you need channels diverted, ask whoever runs this host.';

/** Defaults for tune_out tool params. */
export const TUNE_OUT_DEFAULTS = {
  cadenceSeconds: 1800,
  backlogCap: 200,
  maxWakes: 5,
} as const;

/** Coalescing window for wake invocations: a mention storm becomes one
 *  subconscious turn, and max-wakes counts invocations, not messages. */
const WAKE_COALESCE_MS = 2_000;

/**
 * One backlog line: author, then the message's blocks in order — text as
 * is, anything else named by kind (`[image]`, `[document]`), so a release
 * never drops a block silently (#232 gap 4). The author is named once: a
 * server that renders `Name: body` into the text itself is not doubled.
 * A name the line adds is a value someone supplied, kept to one line with
 * its notice openings marked (authorLine), as main's dump writes it.
 */
export function renderHeldLine(m: Pick<StoredMessage, 'participant' | 'content' | 'metadata'>): string {
  const author = authorNamed(m.metadata) ?? m.participant;
  const parts = m.content.map((b: ContentBlock) =>
    b.type === 'text' ? (b as Extract<ContentBlock, { type: 'text' }>).text : `[${b.type}]`,
  );
  const line = parts.filter((p) => p.length > 0).join(' ');
  const firstText = m.content.find((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')?.text;
  return firstText !== undefined && beginsWithAuthorLine(author, firstText) ? line : authorLine(author, line);
}

/** One reader invocation under `reader: 'forks'` (see SubconsciousConfig). */
export interface ReaderInvocation {
  serverId: string;
  channelId: string;
  epochId: string;
  trigger: 'cadence' | 'wake' | 'cancel';
  /** The host-framed notice for this invocation (bracket style). */
  notice: string;
  /**
   * Held messages not yet handed to any reader fork, oldest first. A held
   * message is stored as it arrives, whatever the resident's turn (#291), so
   * a reader is handed what arrives while the resident is busy, which is
   * when a reader is most useful.
   */
  backlog: StoredMessage[];
  /** Standing dispositions, as text, or null when there are none. */
  dispositions: string | null;
  /**
   * Set on the one look asked for after its epoch had ended: the late look
   * that is handed what a reader that failed after the end was handed
   * (readerFailed). An epoch's cancel looks, asked for as it ends, don't
   * carry it.
   */
  epochEnded?: true;
}

/**
 * Where the persistent subconscious's window starts (#291, AF-5): at the
 * oldest active tune-out's start, never forward past one, so a tune-out's
 * reader sees every message it held. `sequence` is where the tune-out
 * started in the record (its startedAtSequence), which places the start
 * while the subconscious's window is the record. Once its window follows the
 * presentation index, the start is a place in that window, an index
 * ordinal, fixed once per tune-out and recorded (`ordinal`;
 * TuneOutCoordinator.subconsciousWindowFixed), since a row stored before
 * the start can be presented after it, and the sequence converted again
 * then gives another window. `epochIds` are the active tune-outs starting
 * there: one, or a channel's and the all-except hold's begun at the same
 * sequence.
 */
export interface SubconsciousWindowStart {
  sequence: number;
  /** The start as the subconscious's index ordinal, once fixed for one of `epochIds`. */
  ordinal?: number;
  epochIds: readonly string[];
  /**
   * At a resume: `ordinal` is the start in force before the restart (a
   * cancelled tune-out's, earlier than the start kept for `epochIds`), set
   * again and kept as the start in force only, never as theirs.
   */
  inForceOnly?: true;
  /**
   * At a resume that finds no start in force kept, `ordinal` being the one
   * kept for `epochIds`: the anchor the subconscious's strategy persisted is
   * kept where it is earlier (a cancelled tune-out's start that was set but
   * never kept), as the start in force only.
   */
  keepEarlierAnchor?: true;
}

/**
 * What `subconscious/<primary>/window-starts` keeps (`{ v: 1, starts,
 * inForce? }`): each active tune-out's window start as an index ordinal, by
 * epoch id, and the ordinal the window start is set to now (`inForce`),
 * which may be a cancelled tune-out's while another stays active, since a
 * cancel leaves the start where it was.
 */
interface WindowStartsState {
  starts: Record<string, number>;
  inForce?: number;
}

/**
 * The answer to a cancel that waits for held writes (deferCancel): what it
 * waits for, and what a stop meanwhile does. `noteDropped`: the caller's
 * note isn't delivered, as the cancel already waiting carries one.
 * `noteKept`: the caller's note waits with the cancel, and the answer says
 * what becomes of it: delivered when the hold ends, else told lost to its
 * author (tellNoteLost), a notice that can't be written being traced and
 * tried again (writeLossNotices) until it is written, and, for the
 * persistent subconscious (`persistent`), kept in the store too
 * (writeLossRecord), so the next boot writes one a stop left unwritten
 * (restoreLossNotices). Where another cancel ends the hold and the note
 * can't be delivered then, the loss is told in that cancel's release
 * (queuedNoteFirst), which the subconscious's window holds. The waiting
 * cancel, and the note with it, is kept in memory only: a stop before the
 * hold ends loses both, and the subconscious is told of the note's loss
 * as of any other, by a notice kept in the store for the next boot (stop),
 * or, where the store refuses that or the host crashes, by the next boot's
 * notice that any cancel then waiting was lost (noteUnstampedStop).
 * The cancel can't wait for the delivery, which comes only when the hold
 * ends.
 * A reader fork's (`fork`) goes out as its mail even after its run has
 * ended (deliverReaderNote), but a notice of its loss reaches it only while
 * it runs: an ended fork is no agent the framework writes to, and the loss
 * is then traced only (writeLossNotice); a stop drops a fork's notice not
 * yet written.
 */
export function cancelWaitsNote(what: string, noteDropped = false, noteKept?: 'persistent' | 'fork', unmarked = false): string {
  const hold = what.charAt(0).toLowerCase() + what.slice(1);
  const retry = 'tried again every 60 s, except while such a change or refusal lasts, and as soon as one ends, until it is ';
  return 'Not cancelled yet: an operator\'s change to the store is in progress, or a context the cancel writes to '
    + 'refuses writes until the host re-initializes it, so the cancel waits until that is over. Cancelling again '
    + 'doesn\'t end the wait sooner, and how long it lasts isn\'t known here. '
    + `${what} stays in force until then, and what it held is delivered when it ends. If the host stops before then, `
    + 'the cancel is lost and it is still in force after the restart, unless its end time has passed by then.'
    + (noteDropped ? ' Your note isn\'t delivered with it: the cancel already waiting carries a note of its own.' : '')
    + (noteKept === 'persistent' && !noteDropped
      ? ` Your note waits with the cancel and is delivered when ${hold} ends. If it can't be delivered then, you are `
        + 'told so in your context, and why. If writing that notice fails too, the failure is traced for the host, and '
        + `the notice is ${retry}written. The notice is kept in the store as well, unless the store refuses that too: `
        + 'if the host stops before the notice is written, the host writes it when it starts again, or keeps trying as '
        + 'above. The waiting cancel isn\'t kept in the store: if the host stops before '
        + `${hold} ends, the cancel and your note are lost, and you are told so by such a notice, kept in the store `
        + 'for the host to write when it starts again; if the store refuses that too, or the host crashes, you are told '
        + `when it starts again that any cancel of ${hold} then waiting was lost, with any note left with it.`
        + (unmarked
          ? ' This run\'s start couldn\'t be recorded in the store yet: if the host stops or dies before the cancel runs '
            + 'while the store still refuses it, you may not be told so when it starts again.'
          : '')
      : '')
    + (noteKept === 'fork' && !noteDropped
      ? ` Your note waits with the cancel and goes to the resident as your mail when ${hold} ends, even if your run `
        + 'has ended by then. If it can\'t be delivered then, you are told so in your context, and why, but only while '
        + 'your run lasts: once it has ended, nothing can be written to you, so the loss reaches no one and is only '
        + 'traced for the host. If writing that notice fails while you still run, the failure is traced for the host, '
        + `and the notice is ${retry}written, your run ends, or the host stops. If the host stops before ${hold} ends, `
        + 'your note is lost with the cancel, and you are not told.'
      : '');
}

/**
 * The reason a reader's cancel_tuneout gives its cancel, which the resident
 * reads in the cancel's lifecycle line ("[Tune-out: #x cancelled — by Muse,
 * 2 wakes]"), the reader in its cancel notice, and a host in the trace: who
 * cancelled, by the name it runs under (the persistent reader's, or a reader
 * fork's own), marked as a value the host supplied, or "the reader" where the
 * call names none. It says who, never why. The line an all-except hold's
 * release posts in the excepted channel says "by its reader" instead
 * (cancelAllExcept): an agent's name there would show the channel an
 * internal identity.
 */
function cancelledBy(caller: string | undefined): string {
  return caller ? `by ${suppliedValue(caller)}` : 'by the reader';
}

/** A message a cancel reads: a stored row has its id; a write a surgery's hold keeps in memory has none yet. */
type HeldRow = Pick<StoredMessage, 'participant' | 'content' | 'metadata'> & { id?: string };

/**
 * The write a stored row landed from, when an earlier version's deferred
 * queue held it: the boot's import stores it with the queued write's id
 * (`metadata.deferredWriteId`), which a release record that version wrote
 * names it by.
 */
function writeIdOf(m: Pick<StoredMessage, 'metadata'>): string | undefined {
  const writeId = (m.metadata as { deferredWriteId?: unknown } | undefined)?.deferredWriteId;
  return typeof writeId === 'string' ? writeId : undefined;
}

interface RowKeys {
  ids: string[];
  writeIds: string[];
}

/**
 * What a dump row records in its metadata (`released`): the held rows it
 * covered, those its cap left out among them, by write id where the row
 * came through a deferred queue and by id otherwise; how many it covered
 * and left out; and the rows it left for the subconscious's report, which a
 * version with the deferred queue hands it and this one never does (every
 * held message is stored, #291), so `report` is empty here. A write a
 * surgery's hold keeps has no id yet, so a dump made during the hold
 * (writesHeld having thrown) can't name it, and a retry dumps it again.
 */
interface ReleaseRecord extends RowKeys {
  total: number;
  truncated: number;
  report: RowKeys;
}

function keysOf(rows: readonly HeldRow[]): RowKeys {
  const keys: RowKeys = { ids: [], writeIds: [] };
  for (const m of rows) {
    const writeId = writeIdOf(m);
    if (writeId !== undefined) keys.writeIds.push(writeId);
    else if (m.id !== undefined) keys.ids.push(m.id);
  }
  return keys;
}

function keyedBy(keys: readonly RowKeys[]): (m: HeldRow) => boolean {
  const ids = new Set(keys.flatMap((k) => k.ids));
  const writeIds = new Set(keys.flatMap((k) => k.writeIds));
  return (m) => {
    const writeId = writeIdOf(m);
    return writeId !== undefined ? writeIds.has(writeId) : m.id !== undefined && ids.has(m.id);
  };
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
const isRowKeys = (value: unknown): value is RowKeys =>
  typeof value === 'object' && value !== null && isStrings((value as RowKeys).ids) && isStrings((value as RowKeys).writeIds);

function isReleaseRecord(value: unknown): value is ReleaseRecord {
  if (!isRowKeys(value)) return false;
  const record = value as Partial<ReleaseRecord>;
  return typeof record.total === 'number' && typeof record.truncated === 'number' && isRowKeys(record.report);
}

function releaseRecordsOf(rows: readonly HeldRow[], epochId: string): ReleaseRecord[] {
  const records: ReleaseRecord[] = [];
  for (const m of rows) {
    const meta = m.metadata as { kind?: unknown; epochId?: unknown; released?: unknown } | undefined;
    if (meta?.kind !== 'tune-out-cancel' || meta.epochId !== epochId) continue;
    if (isReleaseRecord(meta.released) && !records.some((r) => JSON.stringify(r) === JSON.stringify(meta.released))) {
      records.push(meta.released);
    }
  }
  return records;
}

function truncationNote(records: readonly ReleaseRecord[]): string {
  const truncated = records.reduce((n, r) => n + r.truncated, 0);
  if (truncated === 0) return '';
  const total = records.reduce((n, r) => n + r.total, 0);
  return records.length === 1
    ? ` ${truncated} of ${total} diverted messages, the oldest, weren't delivered raw to the resident.`
    : ` ${truncated} of ${total} diverted messages across ${records.length} dumps, the oldest in each dump that left any out, weren't delivered raw to the resident.`;
}

/**
 * Whether a held message is one of this channel's: by its channel id, and by
 * its server where it records one, since two servers can register the same
 * channel id. A message recording neither is taken as the channel's, as
 * before servers were recorded.
 */
function inChannelOf(serverId: string, channelId: string): (m: Pick<StoredMessage, 'metadata'>) => boolean {
  return (m) => {
    const meta = m.metadata as { channelId?: string; serverId?: string } | undefined;
    return (meta?.channelId ?? channelId) === channelId && (meta?.serverId ?? serverId) === serverId;
  };
}

/**
 * The all-except scope (issue #232 §3.2; focus folded into tune-out): a
 * resident-level policy epoch holding every channel but one, for a bounded
 * time. It covers DMs and channels registered after entry, since the
 * decision is "not the exception" rather than a per-channel state.
 */
export interface AllExceptParams {
  epochId: string;
  except: { serverId: string; channelId: string };
  cadenceSeconds: number;
  /** Per held channel, at release. */
  backlogCap: number;
  /** Reader wakes before the reader is paused (the hold itself stays). */
  maxWakes: number;
  startedAtSequence: number;
  startedAtMs: number;
  /** Mandatory: the scope always ends on its own. */
  expiresAtMs: number;
  source: string;
}

export interface AllExceptState {
  params: AllExceptParams;
  wakeCount: number;
}

/** `check`: what is held right now, without releasing anything. */
export interface TuneOutCheck {
  allExcept: { epochId: string; except: { serverId: string; channelId: string }; expiresAtMs: number; wakeCount: number; held: Record<string, number> } | null;
  channels: Array<{ serverId: string; channelId: string; epochId: string; held: number; expiresAtMs?: number }>;
  /** Up to `peekLimit` newest held lines of the peeked channel, oldest first. */
  peek?: string[];
}

/** The most characters of a note's first line a boot's notice of an unrecorded stop quotes (askedCancelOf). */
const NOTE_QUOTE_CHARS = 120;

/** How long after an end time's or a wake budget's cancel threw, or a deferred cancel's run, the cancel is tried again. */
const EXPIRY_RETRY_MS = 60_000;
/** How many times releaseAll tries a release that keeps failing, backing off from EXPIRY_RETRY_MS. */
const RELEASE_RETRY_ATTEMPTS = 5;

/** The hold a deferred cancel was asked for (deferCancel). */
interface DeferredFor {
  /** The epoch it was asked for, the one it ends. */
  epochId: string;
  /** Where the hold is, for its trace: the channel's, or the all-except hold's excepted channel. */
  serverId: string;
  channelId: string;
  scope?: 'all-except';
  /** The epoch holding there now, undefined when none does. */
  current: () => string | undefined;
}

/** A cancel asked for while writes were kept in memory, waiting for them to be stored (deferCancel). */
interface DeferredCancel {
  for: DeferredFor;
  /** The hold and the cancel's reason, as its log lines name them. */
  what: string;
  /** Run it (runDeferredCancels), with the note it carries then: a later cancel's, where it had none (deferCancel). */
  run: (queued: DeferredCancel) => void;
  note?: string;
  noteAuthor?: string;
  /** Its note was delivered, or its loss told (deliverQueuedNote, dropDeferred). */
  noteSettled?: true;
}

/**
 * Why a deferred cancel left its queue undone (dropDeferred): `hold-ended`,
 * its epoch's hold ended without it (`current`, the epoch holding there
 * then, if one did); `note-undelivered`, its hold ended, by another cancel
 * or by its own run (`by`), and the note it carried could not be delivered
 * (`error`); `stopped`, the host stopped while it waited, its hold still in
 * force (stop).
 */
type DeferredDrop =
  | { reason: 'hold-ended'; current?: string }
  | { reason: 'note-undelivered'; by: 'another' | 'itself'; error: string }
  | { reason: 'stopped' };

/**
 * Why a loss notice (LossNotice) is written: a deferred cancel's drop
 * (DeferredDrop), or `unstamped-stop`, the boot found a hold on record
 * that the last stop's stamp doesn't cover (noteUnstampedStop): a crash,
 * or a stop whose writes the store refused (UnstampedStop): what that
 * run's rows show of a waiting cancel, `delivered` (its note's row is the
 * residents', no release since), `ran` (a release of that epoch was
 * stored since the cancel was asked, its end not recorded), `asked` (the
 * subconscious's own call of it, answered as waiting), or `unknown`
 * (nothing: none waited, or one waited and its ask was lost with its
 * turn).
 */
type LossReason = DeferredDrop | UnstampedStop;

/**
 * What a boot found of a hold the last stop didn't stamp (LossReason):
 * `found`, and with it whether the subconscious's own call of the cancel
 * was found (`asked`), the first line of the note it left (`note`), and
 * whether the note's row is the residents' (`noteDelivered`); for `ran`,
 * whose cancel stored the release: the subconscious's own (`own`), or
 * another's, by the reason its release gives (`ranBy`), where it gives one.
 */
interface UnstampedStop {
  reason: 'unstamped-stop';
  found: 'delivered' | 'ran' | 'asked' | 'unknown';
  asked?: true;
  note?: string;
  noteDelivered?: true;
  own?: true;
  ranBy?: string;
}

/** How definite each finding is (noteUnstampedStop): a later boot tells a hold again only what says more. */
const FOUND_RANK: Record<UnstampedStop['found'], number> = { unknown: 0, asked: 1, delivered: 2, ran: 2 };

/**
 * What `tune-out/<primary>/stop-stamp` keeps (`{ v: 1, epochs,
 * runStartedAt? }`): the holds on record at the last stop (their epochs)
 * whose waiting cancels that stop accounted for, a note's loss written or
 * kept in the store (writeStopStamp), and the store's head sequence when
 * that run began. Each boot reads it and writes it again covering no hold,
 * with its own run's start (noteUnstampedStop), so a crash leaves a stamp
 * that covers nothing and bounds the rows the next boot reads.
 */
interface StopStamp {
  v: 1;
  epochs: string[];
  runStartedAt?: number;
}

/** A hold on record (holdsOnRecord): its epoch, and its channel, the all-except hold's excepted one with `scope`. */
interface HoldOnRecord {
  epochId: string;
  serverId: string;
  channelId: string;
  scope?: 'all-except';
  /** The store's sequence when it began, where its record keeps one. */
  startedAt?: number;
}

/** A notice to a lost note's author (tellNoteLost), kept until it is written (writeLossNotices). */
interface LossNotice {
  /** Tells it from the others kept, in the store's record too (PersistedLossNotice). */
  id: string;
  /** The hold its cancel was for, and the epoch holding there now (DeferredFor), read when it is written. */
  for: Pick<DeferredFor, 'epochId' | 'serverId' | 'channelId' | 'scope' | 'current'>;
  /** The hold and its cancel's reason, as the log lines name them. */
  what: string;
  /** Why the note was lost, which the notice says. */
  drop: LossReason;
  /** When it was kept (Date.now()). */
  keptAtMs: number;
  /**
   * For a boot's notice of an unrecorded stop, the store's head when the
   * boot kept it: a later boot reads it as told then (noteUnstampedStop).
   */
  keptAtSequence?: number;
  /** A write of it failed, which was traced (once). */
  traced?: true;
  /**
   * Its author is the persistent subconscious, whose context outlives the
   * process: the notice is kept in the store too (writeLossRecord), so a
   * stop doesn't lose it. A reader fork's isn't: no fork outlives a stop.
   */
  persistent?: true;
}

/**
 * A loss notice for the persistent subconscious not written yet (LossNotice),
 * as `tune-out/<primary>/loss-notices` keeps it (`{ v: 1,
 * pendingLossNotices }`): whom it is for (`author`), the hold and its
 * cancel's reason (`what`), the hold's epoch and channel (`for`; the
 * all-except hold's excepted channel, with `scope`), why the note was lost
 * (`drop`, whose `error` is the reason the notice gives), when it was kept,
 * and whether its first failure was traced. The next boot writes it
 * (restoreLossNotices).
 */
interface PersistedLossNotice {
  id: string;
  author: string;
  what: string;
  for: { epochId: string; serverId: string; channelId: string; scope?: 'all-except' };
  drop: LossReason;
  keptAtMs: number;
  keptAtSequence?: number;
  traced?: true;
}

/** What a loss notice tells its author, as the log lines name it. */
function lossSubject(notice: Pick<LossNotice, 'what' | 'drop'>): string {
  if (notice.drop.reason !== 'unstamped-stop') return `that the note it left with the cancel of ${notice.what} was not delivered`;
  return `that the host stopped without recording the state of ${notice.what}`
    + (notice.drop.found === 'delivered' ? ', after the note it left with a cancel of it was delivered'
      : notice.drop.found === 'ran' ? ', after a cancel of it ran, its end not recorded'
      : notice.drop.found === 'asked' ? ', so that the cancel of it it asked for was lost' : ', so that a cancel of it then waiting was lost');
}

/** A kept notice in the record's form, or undefined for an entry this version can't read. */
function readPersistedLossNotice(value: unknown): PersistedLossNotice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const at = entry.for as Record<string, unknown> | null | undefined;
  const drop = entry.drop as Record<string, unknown> | null | undefined;
  if (typeof entry.id !== 'string' || typeof entry.author !== 'string' || entry.author === ''
    || typeof entry.what !== 'string' || typeof entry.keptAtMs !== 'number') return undefined;
  if (!at || typeof at !== 'object' || typeof at.epochId !== 'string' || typeof at.serverId !== 'string'
    || typeof at.channelId !== 'string' || (at.scope !== undefined && at.scope !== 'all-except')) return undefined;
  let why: LossReason;
  if (drop?.reason === 'hold-ended' && (drop.current === undefined || typeof drop.current === 'string')) {
    why = { reason: 'hold-ended', ...(typeof drop.current === 'string' ? { current: drop.current } : {}) };
  } else if (drop?.reason === 'note-undelivered' && (drop.by === 'another' || drop.by === 'itself') && typeof drop.error === 'string') {
    why = { reason: 'note-undelivered', by: drop.by, error: drop.error };
  } else if (drop?.reason === 'stopped') {
    why = { reason: 'stopped' };
  } else if (drop?.reason === 'unstamped-stop') {
    const found = drop.found === 'delivered' || drop.found === 'ran' || drop.found === 'asked' ? drop.found : 'unknown';
    why = {
      reason: 'unstamped-stop', found,
      ...(drop.asked === true ? { asked: true as const } : {}),
      ...(typeof drop.note === 'string' ? { note: drop.note } : {}),
      ...(drop.noteDelivered === true ? { noteDelivered: true as const } : {}),
      ...(drop.own === true ? { own: true as const } : {}),
      ...(typeof drop.ranBy === 'string' ? { ranBy: drop.ranBy } : {}),
    };
  } else {
    return undefined;
  }
  return {
    id: entry.id, author: entry.author, what: entry.what,
    for: { epochId: at.epochId, serverId: at.serverId, channelId: at.channelId, ...(at.scope === 'all-except' ? { scope: 'all-except' as const } : {}) },
    drop: why, keptAtMs: entry.keptAtMs,
    ...(typeof entry.keptAtSequence === 'number' ? { keptAtSequence: entry.keptAtSequence } : {}),
    ...(entry.traced === true ? { traced: true as const } : {}),
  };
}

/** A row of the persistent subconscious's window as the boot reads it (subconsciousWindow). */
export type WindowRow = Pick<StoredMessage, 'participant' | 'content' | 'metadata' | 'sequence'> & { shardIndex?: number };

/**
 * The rows of a window (`window`, the persistent subconscious's, `author`)
 * that `keep` keeps and that come after its last row of its own: shown to
 * it, and no turn of its since. A note of its that a cancel delivered is a
 * row under its name but no turn of it (`subconscious-note`), so isn't its
 * own here. A row stored in shards is one row: its first shard.
 */
export function unansweredIn(window: readonly WindowRow[], author: string, keep: (m: WindowRow) => boolean): WindowRow[] {
  let after = 0;
  window.forEach((m, at) => {
    if (m.participant === author && (m.metadata as { kind?: unknown } | undefined)?.kind !== 'subconscious-note') after = at + 1;
  });
  return window.slice(after).filter((m) => (m.shardIndex ?? 0) === 0 && keep(m));
}

/** A `cancel_tuneout` call of the persistent subconscious's (cancelAsksIn). */
export interface CancelAsk {
  /** Its row's sequence. */
  sequence: number;
  input: Record<string, unknown>;
  /** Its result answered it as waiting (`waiting: true`). */
  waiting: boolean;
  /** The server its result names, where it names one. */
  serverId?: string;
  /** The scope its result names (`all-except`), where it names one. */
  scope?: string;
}

/** A tool result's content as an answer's JSON object, or undefined where it isn't one (a guard's placeholder, say). */
function answerIn(content: unknown): Record<string, unknown> | undefined {
  const raw = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((c) => ((c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : '')).join('')
    : '';
  try {
    const answer = JSON.parse(raw) as unknown;
    return answer && typeof answer === 'object' && !Array.isArray(answer) ? answer as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `cancel_tuneout` calls a window (`window`, the persistent
 * subconscious's, `author`) holds, its own rows', each with what its
 * result, where the window holds it, answered: waiting or not, and the
 * server and scope it names. A result row that isn't an answer's JSON (the
 * tool-result guard's placeholder, its batch not settled) is read from
 * `archived`, the original results by tool use id (the guard's audit,
 * subconsciousGuardedResults), where it holds one. A result that isn't
 * there, or isn't an answer, isn't waiting.
 */
export function cancelAsksIn(window: readonly WindowRow[], author: string, archived?: ReadonlyMap<string, unknown>): CancelAsk[] {
  const results = new Map<string, Record<string, unknown>>();
  for (const m of window) {
    for (const b of m.content as Array<{ type: string; toolUseId?: unknown; tool_use_id?: unknown; content?: unknown }>) {
      if (b.type !== 'tool_result') continue;
      const id = typeof b.toolUseId === 'string' ? b.toolUseId : b.tool_use_id;
      if (typeof id !== 'string') continue;
      const answer = answerIn(b.content) ?? (archived?.has(id) ? answerIn(archived.get(id)) : undefined);
      if (answer) results.set(id, answer);
    }
  }
  const asks: CancelAsk[] = [];
  for (const m of window) {
    if (m.participant !== author) continue;
    for (const b of m.content as Array<{ type: string; id?: unknown; name?: unknown; input?: unknown }>) {
      if (b.type !== 'tool_use' || b.name !== 'cancel_tuneout' || typeof b.id !== 'string') continue;
      const answer = results.get(b.id);
      asks.push({
        sequence: m.sequence,
        input: b.input && typeof b.input === 'object' ? b.input as Record<string, unknown> : {},
        waiting: answer?.waiting === true,
        ...(typeof answer?.serverId === 'string' ? { serverId: answer.serverId } : {}),
        ...(typeof answer?.scope === 'string' ? { scope: answer.scope } : {}),
      });
    }
  }
  return asks;
}

/** Ends a backlog line cut to fit in one of the residents' messages. */
const CUT_MARK = ` [${NOTICE_TAG.cutToFit}; the whole message is in the channel's history]`;

/**
 * tune_out's refusal of a channel already tuned out: its settings, then what
 * its transport is now where the repeat tried to open it again (`transport`,
 * from the framework's dispatch), then how to change the settings.
 */
export function alreadyTunedOutText(quoted: string, p: TuneOutParams, transport?: string): string {
  // A duration so long its end is past what a Date can hold has no time to show.
  const expires = p.expiresAtMs !== undefined ? new Date(p.expiresAtMs) : undefined;
  const until = expires && Number.isFinite(expires.getTime())
    ? `, until ${expires.toISOString().replace(/\.\d+Z$/, 'Z')}`
    : '';
  // A thrown error's words may end without a stop.
  const now = transport === undefined ? '' : /[.!?]$/.test(transport) ? `${transport} ` : `${transport}. `;
  return `Nothing changed${transport !== undefined ? ' in the tune-out' : ''}: ${quoted} is already `
    + `tuned out, with cadenceSeconds ${p.cadenceSeconds}, backlogCap ${p.backlogCap} and maxWakes ${p.maxWakes}${until}. `
    + now
    + 'To change those, cancel it first with tune_out mode "cancel", which delivers its backlog to you now, then call '
    + 'tune_out again with the new settings.';
}

/** What a thrown value says, without throwing: an Error's message, or the
 *  value as text, which String() can't give for an object with no prototype. */
function thrownReason(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return '(a value that could not be read)';
  }
}

export interface TuneOutFrameworkHooks {
  /** Deliver a message into an agent's window (per-agent seam). */
  addMessage: (
    participant: string,
    content: ContentBlock[],
    metadata?: Record<string, unknown>,
    forAgent?: string,
  ) => string;
  /** Queue an inference request for an agent. */
  requestInference: (agentName: string, reason: string, source: string) => void;
  /** The persistent subconscious's registry/participant name, or null. */
  subconsciousName: () => string | null;
  /**
   * `reader: 'forks'`: derive and run one reader fork. Absent in persistent
   * mode. The framework owns the fork's lifecycle; the coordinator owns the
   * epoch.
   */
  invokeReader?: (invocation: ReaderInvocation) => void;
  /**
   * `reader: 'forks'`: deliver a reader fork's own words to the resident
   * as attributed mail (its name, its incarnation). Absent in persistent
   * mode, where the subconscious writes under its own name directly.
   */
  deliverFromReader?: (reader: string, content: ContentBlock[], metadata: Record<string, unknown>) => void;
  /** The primary resident's registry name. */
  primaryName: () => string | null;
  /**
   * Read the primary's stored messages (shared slot, unfiltered). A held
   * message is stored as it arrives, even during the resident's turn, so
   * this is every message an epoch holds (#232 gap 7), but for those a live
   * surgery's hold keeps in memory (getSurgeryHeldMessages).
   */
  getStoredMessages: () => StoredMessage[];
  /**
   * The writes for the primary's store that a live surgery's hold keeps in
   * memory, in arrival order: made while the operator's switch is awaited,
   * and stored, in that order, only at its release. A check during the hold
   * counts and peeks a tune-out's held messages among them as it does the
   * stored ones (#232 gap 7). A cancel waits for the release (writesHeld),
   * so a dump lists them only where writesHeld throws and the cancel goes
   * on during the hold. Left out, none are.
   */
  getSurgeryHeldMessages?: () => Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>>;
  /**
   * Make what was just delivered durable, and answer whether it is: a cancel
   * stores its release and makes it durable before it records the epoch's
   * end (#232 gap 6), and a release that can't be (false) leaves the
   * tune-out in force, the cancel throwing. Left out, a stored release
   * counts as durable.
   */
  commitDeliveries?: () => boolean;
  /**
   * Whether a write the coordinator made now would be kept in memory rather
   * than stored: a live surgery's hold, or a context manager of the primary
   * or the subconscious refusing its work until a branch move re-initializes it.
   * A cancel then waits (deferCancel), the tune-out still in force, until
   * the framework says the writes are stored again, or told of where storing
   * one fails (runDeferredCancels), so the release is in the store before
   * the epoch's end is recorded. Left out, never.
   */
  writesHeld?: () => boolean;
  /**
   * The history-reading tool the resident actually has (e.g. a server's
   * `fetch_history`), or null. A truncation note names it only when it exists
   * (#232 gap 11).
   */
  historyTool?: () => string | null;
  /**
   * The most characters of text every reader of the residents' shared slot
   * is shown whole in one message: the smallest of their strategies'
   * per-message caps (`maxMessageTokens`) at four characters a token, or
   * undefined when none has such a cap. A cancel's dump is one message in
   * that slot, so it holds as many backlog lines as fit.
   */
  residentMessageChars?: () => number | undefined;
  /** Current chronicle head sequence (window anchor for new epochs). */
  currentSequence: () => number;
  /**
   * Move the subconscious window anchor to `start`, the oldest active
   * tune-out's (never forward past active epochs): by its sequence while
   * the subconscious's window is the record, by its ordinal once that is
   * known, and else by an ordinal the framework fixes for it and reports
   * (subconsciousWindowFixed). `others` are the other active tune-outs'
   * starts whose ordinal isn't kept yet, which the framework fixes and
   * reports the same way without moving the window to them.
   */
  setSubconsciousAnchor: (start: SubconsciousWindowStart, others?: readonly SubconsciousWindowStart[]) => void;
  /**
   * Whether the subconscious's window keeps index ordinals (its context
   * manager presents rows, #291), so each tune-out's window start is kept as
   * one (`subconscious/<primary>/window-starts`). Left out, or false, none
   * is kept or read, and the anchor goes by sequence alone.
   */
  subconsciousWindowOrdinals?: () => boolean;
  /**
   * How many of the residents' stored messages `keep` keeps that the
   * persistent subconscious hasn't been shown yet: with the presentation
   * index, those its window doesn't hold; else those stored after its last
   * compile. A cancel the subconscious makes itself gives it a report turn
   * when any of its tune-out's are, since it wrote its note without them.
   * Left out, none are.
   */
  unseenBySubconscious?: (keep: (m: Pick<StoredMessage, 'metadata'>) => boolean) => number;
  /**
   * The persistent subconscious's window, as written down (its presented
   * rows): a boot reads it for the losses told to it whose turn a stop lost
   * (askTurnsForUnreadLosses), for its own cancels of a hold the last stop
   * didn't stamp, and for what it was told of that stop already
   * (noteUnstampedStop). Left out, or with no subconscious, none.
   */
  subconsciousWindow?: () => readonly WindowRow[];
  /**
   * The persistent subconscious's tool results as the tool-result guard
   * archived them before it stored their placeholders (its audit's staged
   * batches), by tool use id: a boot reads one where a crash before the
   * guard settled left the placeholder for the result (cancelAsksIn). Left
   * out, or with no guard's audit, none.
   */
  subconsciousGuardedResults?: () => ReadonlyMap<string, unknown>;
  /** True when a channel is bound to a conversation-fork agent. */
  isForkBound: (channel: ChannelRef) => boolean;
  /** Gate privileged-users list (#77: privileged authors wake, like mentions). */
  isPrivilegedAuthor: (authorId: string | null | undefined) => boolean;
  /** speak_in_channel master switch (recipe-side, canary-gated). */
  allowChannelSpeech: () => boolean;
  /**
   * Post a line into a channel under the resident's name. Used for the
   * all-except scope's entry and release announcements in the excepted
   * channel (Linn, 2026-10-12: the room should hear the door shut, not
   * discover it). Absent when `tuneOut.announce` is off.
   */
  announce?: (serverId: string, channelId: string, text: string) => Promise<{ success: boolean; error?: string }>;
  emitTrace: (event: TraceEventInput) => void;
}

export class TuneOutCoordinator {
  private cadenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Each duration's pending timer: a step toward its end time
   *  (params.expiresAtMs), or the retry of an end-time cancel that threw.
   *  stop clears it, cancel does when it finds the tune-out in the registry,
   *  the end time does when its cancel finds the tune-out already ended,
   *  and the channel's next accepted enter does in any case. */
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** A releaseAll asked to retry its failures (a reader that ended): the next try. */
  private releaseRetry: ReturnType<typeof setTimeout> | null = null;
  /** stop() has run: no timer is armed after it. */
  private stopped = false;
  /** Channels with a wake invocation pending inside the coalescing window. */
  private pendingWakes = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>();
  /**
   * Held messages the channel's reader hasn't looked at, per channel key:
   * what makes a cadence period worth a look. Counted up as messages are
   * held and back to zero at each look; rebuilt from the held rows where
   * memory can't know it (rebuildTally): after a restart, and when a
   * channel's own tune-out ends while the all-except hold still holds it.
   * A failed reader fork's messages count again (readerFailed).
   */
  private divertedSinceInvocation = new Map<string, number>();
  /**
   * The persistent subconscious's last look at each held channel, per epoch:
   * the store's sequence when the look was asked for. Durable, so that after
   * a restart its next look counts only what was held since (rebuildTally).
   * Reader forks need none: what they were handed is in memory, and after a
   * restart the first fork of an epoch is handed all it has held.
   */
  private lastLooksCache: Record<string, Record<string, number>> | undefined;
  /**
   * `reader: 'forks'`: the highest sequence of a held message already
   * handed to a reader fork, per epoch and channel (handOffKey). Each held
   * message is delivered to exactly one fork. A channel the all-except hold
   * holds can be taken by a tune-out of its own and given back, and each
   * epoch's readers read that epoch's messages, so what one epoch's readers
   * were handed never moves or clears the other's. In-memory: after a
   * restart the first fork of an epoch is handed everything the epoch has
   * held, which is the right side to err on.
   */
  private readerCursor = new Map<string, number>();
  /**
   * `reader: 'forks'`: held messages a reader fork was handed but never read,
   * per epoch and channel, by id: its derive failed, or its run threw before
   * it reported (readerFailed). The next invocation is handed them again,
   * cursor or no. Cleared with the cursor.
   */
  private readerReturned = new Map<string, Set<string>>();
  /**
   * `reader: 'forks'`: the late forks derived for an ended epoch's messages
   * (readerFailed), so that a late fork's own failure derives no other.
   */
  private lateForks = new WeakSet<object>();
  /** The all-except scope's durable record, cached (undefined = not read yet). */
  private scopeCache: AllExceptState | null | undefined;
  /**
   * Cancels asked for while the framework keeps writes in memory
   * (writesHeld), by channel key, the all-except hold's under SCOPE_KEY:
   * each runs as it was asked, with its note, or a later cancel's when it
   * had none (deferCancel), once the writes are stored again, or told of
   * where storing one fails (runDeferredCancels). Each is for the epoch it
   * was asked for (`for`), and ends that one only: one whose epoch no longer
   * holds is dropped, told (dropDeferred), never run against a later one.
   * In memory: a restart before then finds the tune-out still in force,
   * and an end time that passed cancels it at once (resumeActiveEpochs); a
   * note one carries is told lost at the stop, its notice kept in the store
   * for the persistent subconscious (stop).
   */
  private readonly deferredCancels = new Map<string, DeferredCancel>();
  /**
   * The notices to a lost queued note's author that weren't written yet
   * (tellNoteLost), by author, in the order the losses came: each is tried
   * again, by runDeferredCancels, at the next release and at the retry,
   * until it is written. Those for the persistent subconscious are kept in
   * the store too (writeLossRecord), and stay there at stop for the next
   * boot to write (restoreLossNotices); a reader fork's are in memory only,
   * cleared at stop, as the deferred cancels are.
   */
  private readonly lossNotices = new Map<string, LossNotice[]>();
  /**
   * The persistent subconscious's kept notices as the store's record was
   * last written or read (writeLossRecord, readLossRecord), so that it is
   * written only when they change.
   */
  private lossRecordShape = '[]';
  /**
   * The record may not hold the notices kept in memory: its write failed,
   * or was put off while writes were held. The next change, or the stop,
   * writes it.
   */
  private lossRecordStale = false;
  /** The record couldn't be read: nothing is written over it until it can be (readLossRecord). */
  private lossRecordUnread = false;
  /**
   * The store's head sequence when this run began (noteUnstampedStop), which
   * the stop's stamp names, so that the next boot reads only this run's rows
   * for what became of a note. Undefined until the boot, or where it
   * couldn't be read.
   */
  private runStartedAt: number | undefined;
  /**
   * This run's stamp (noteUnstampedStop) where the store refused it at boot,
   * tried again until it lands (writePendingMarker); a stop's own stamp
   * replaces it. Meanwhile a waiting cancel's answer to the persistent
   * subconscious says the host's death before the cancel runs may go untold.
   */
  private markerPending: StopStamp | undefined;
  /** A write of `markerPending` failed, which was logged (once). */
  private markerUnwritten = false;
  /**
   * The one retry of the deferred cancels whose run threw (a release that
   * couldn't be made durable, a store operation that threw), and of the
   * loss notices not written (lossNotices), armed by runDeferredCancels and
   * tellNoteLost, unref'd, cleared at stop. A later release's
   * runDeferredCancels runs them sooner.
   */
  private deferredRetry: ReturnType<typeof setTimeout> | undefined;
  /** Timer key for the scope's cadence and expiry. */
  private static readonly SCOPE_KEY = '\0all-except';

  constructor(
    private readonly channelRegistry: ChannelRegistry,
    private readonly serverRegistry: McplServerRegistry,
    private readonly hooks: TuneOutFrameworkHooks,
  ) {}

  private key(serverId: string, channelId: string): string {
    return `${serverId}\0${channelId}`;
  }

  /** The readers' hand-off bookkeeping's key: one epoch's reading of one channel. */
  private handOffKey(epochId: string, serverId: string, channelId: string): string {
    return `${epochId}\0${serverId}\0${channelId}`;
  }

  /** An ended epoch's hand-off bookkeeping goes with it, every channel's. */
  private dropHandOffs(epochId: string): void {
    for (const map of [this.readerCursor, this.readerReturned]) {
      for (const key of map.keys()) if (key.startsWith(`${epochId}\0`)) map.delete(key);
    }
  }

  /** A reader exists: the persistent subconscious, or forks on demand. */
  private readerAvailable(): boolean {
    return this.hooks.subconsciousName() != null || typeof this.hooks.invokeReader === 'function';
  }

  /** Reader forks are the configured reader. */
  private get forkReader(): boolean {
    return this.hooks.subconsciousName() == null && typeof this.hooks.invokeReader === 'function';
  }

  /** A channel as the resident and the subconscious are shown it
   *  (ChannelRegistry.nameShown): its id, or, where another server registers
   *  the same id, its server-qualified name, which tune_out and
   *  cancel_tuneout take back; or, for a channel no string picks alone, its
   *  id and its server. */
  private shown(serverId: string, channelId: string): string {
    return this.channelRegistry.nameShown({ serverId, channelId });
  }

  /**
   * Every message of the primary's store, in arrival order: those stored,
   * then those a live surgery's hold keeps in memory until its release
   * (getSurgeryHeldMessages). What a check counts and peeks, and what a
   * dump lists: a dump made during the hold, which a cancel makes only
   * where writesHeld throws, still has what the tune-out held then. A
   * reader is handed stored rows only (getStoredMessages): those the hold
   * keeps have no id until stored, and the dump has them.
   */
  private residentMessages(): HeldRow[] {
    const stored = this.hooks.getStoredMessages();
    let kept: HeldRow[] = [];
    try {
      kept = this.hooks.getSurgeryHeldMessages?.() ?? [];
    } catch (err) {
      console.error('[tune-out] could not read the writes a surgery holds in memory, so the stored messages alone are read:', err);
    }
    return kept.length > 0 ? [...stored, ...kept] : stored;
  }

  private quotedShown(serverId: string, channelId: string): string {
    return this.channelRegistry.quotedShown({ serverId, channelId });
  }

  /** Restart cadence + expiry timers and re-anchor after a process restart. */
  resumeActiveEpochs(): void {
    // The holds on record before any is resumed or ended here, and the
    // store's head then, for the last stop's stamp (noteUnstampedStop).
    let bootHead: number | undefined;
    try {
      bootHead = this.hooks.currentSequence();
    } catch {
      bootHead = undefined;
    }
    let onRecord: HoldOnRecord[] = [];
    try {
      onRecord = this.holdsOnRecord();
    } catch (err) {
      console.error(`[tune-out] the holds on record could not be read for the last stop's stamp, so none is checked against it: ${thrownReason(err)}`);
    }
    for (const { serverId, channelId, params } of this.listActive()) {
      // An epoch whose deadline passed while the process was down cancels
      // immediately — the resident gets their backlog on the schedule they
      // committed to, not whenever the host happened to restart.
      const inForce = (): boolean => this.channelRegistry.getTuneOutState(serverId, channelId)?.params.epochId === params.epochId;
      const expired = params.expiresAtMs !== undefined && params.expiresAtMs <= Date.now();
      if (expired) {
        try {
          this.cancel(serverId, channelId, 'duration', 'duration elapsed');
          continue;
        } catch (err) {
          if (!inForce()) {
            console.error(`[tune-out] ${this.shown(serverId, channelId)} reached its end time while the process was down and its cancel ended it, but a step after the end failed:`, err);
            continue;
          }
          console.error(`[tune-out] ${this.shown(serverId, channelId)} reached its end time while the process was down, and its cancel failed, so it stays tuned out and its cancel is tried again in ${EXPIRY_RETRY_MS / 1000} s:`, err);
        }
      }
      this.startCadence(serverId, channelId, params.cadenceSeconds);
      const wakeCount = this.channelRegistry.getTuneOutState(serverId, channelId)?.wakeCount ?? 0;
      if (wakeCount > params.maxWakes) {
        this.cancelPastBudget(serverId, channelId, params.maxWakes, 'start');
      } else {
        this.armExpiry(serverId, channelId, expired ? { ...params, expiresAtMs: Date.now() + EXPIRY_RETRY_MS } : params);
      }
    }
    const scope = this.getAllExcept();
    if (scope) {
      // Whether the hold is still in force, and so anchors the subconscious,
      // is read from the record below (anchorSubconscious), as a channel's is.
      if (scope.params.expiresAtMs <= Date.now()) {
        try {
          this.cancelAllExcept('duration', 'duration elapsed');
        } catch (err) {
          if (this.getAllExcept()?.params.epochId !== scope.params.epochId) {
            console.error('[tune-out] the all-except hold reached its end time while the process was down and its release ended it, but a step after the end failed:', err);
          } else {
            console.error(`[tune-out] the all-except hold reached its end time while the process was down, and its release failed, so it stays in force and its release is tried again in ${EXPIRY_RETRY_MS / 1000} s:`, err);
            this.armScopeTimers({ ...scope.params, expiresAtMs: Date.now() + EXPIRY_RETRY_MS });
          }
        }
      } else {
        this.armScopeTimers(scope.params);
      }
    }
    // A window start kept for a tune-out that ended while the process was
    // down, its cancel's own forget not written, goes now.
    this.pruneWindowStarts();
    this.anchorSubconscious('resume');
    // What each held channel's reader hasn't looked at was counted in
    // memory, so it is counted again from the held rows: without it, a
    // channel held across the restart gets no cadence look until something
    // new arrives. Every held message is stored as it arrives (#291), so the
    // stored rows are all of them.
    const held = new Set<string>();
    for (const m of this.hooks.getStoredMessages()) {
      const meta = m.metadata as { tuneOut?: { epochId?: string }; serverId?: string; channelId?: string } | undefined;
      const epochId = meta?.tuneOut?.epochId;
      if (!meta || !epochId || !meta.channelId) continue;
      const key = this.key(meta.serverId ?? '', meta.channelId);
      if (!held.has(key) && this.holdFor(meta.serverId ?? '', meta.channelId)?.epochId === epochId) held.add(key);
    }
    for (const key of held) {
      const [serverId, channelId] = key.split('\0') as [string, string];
      this.rebuildTally(serverId, channelId);
    }
    this.pruneLooks();
    // A loss told to the subconscious before the stop whose turn the stop
    // lost is given its turn again; then a loss notice a stop left kept in
    // the store is written, the holds' state above restored first, which it
    // reads; then those for the holds the last stop didn't stamp.
    this.askTurnsForUnreadLosses();
    this.noteUnstampedStop(onRecord, this.restoreLossNotices(), bootHead);
  }

  /** The tune-outs active now, a channel's and the all-except hold, with where each started in the record. */
  private activeStarts(): Array<{ epochId: string; sequence: number }> {
    const starts = this.listActive().map(({ params }) => ({ epochId: params.epochId, sequence: params.startedAtSequence }));
    const scope = this.getAllExcept();
    if (scope) starts.push({ epochId: scope.params.epochId, sequence: scope.params.startedAtSequence });
    return starts;
  }

  /**
   * Set the subconscious's window start to the oldest active tune-out's
   * (setSubconsciousAnchor), with its ordinal when one was fixed for it. The
   * all-except hold counts with the channels' tune-outs, wherever this is
   * called, so a channel's tune-out entered during an older hold leaves the
   * start at the hold's. Nothing when none is active: the anchor stays where
   * it was, as a cancel leaves it.
   *
   * A cancel leaves the start where it was while another tune-out stays
   * active too, so the subconscious's report on the one cancelled still has
   * what it held, and the start in force is kept (`inForce`). At a resume
   * that start is set again rather than the oldest active tune-out's, which
   * is later than it once the oldest was cancelled: so the window is the
   * same across a restart. An enter sets the oldest active tune-out's, as it
   * always has. Where the window presents, the other active tune-outs whose
   * start isn't kept yet go with it, for the framework to fix as soon as
   * each can be.
   */
  private anchorSubconscious(occasion: 'enter' | 'resume' = 'enter'): void {
    const active = this.activeStarts();
    if (active.length === 0) return;
    const sequence = Math.min(...active.map((e) => e.sequence));
    const epochIds = active.filter((e) => e.sequence === sequence).map((e) => e.epochId);
    const kept = this.ordinalsKept();
    const read = kept ? this.readWindowState() : { starts: {} };
    if (read === null) {
      // Which starts are kept can't be told: set by sequence, the window
      // could move off a start fixed for an active tune-out, and the fix
      // would write over the record. It stays where it was, nothing written;
      // the next enter or restart sets it.
      console.error(`[tune-out] the subconscious's window start stays where it was: its kept starts can't be read; the next enter or restart sets it`);
      return;
    }
    const state: WindowStartsState = read;
    const own = epochIds.map((id) => state.starts[id]).find((o) => o !== undefined);
    let ordinal = own;
    // At a resume, the start in force before the restart (a cancelled
    // tune-out's, say), and never past the oldest active one's own start
    // where one is kept. With none in force kept, the anchor (window-anchor)
    // keeps the one its strategy persisted where that is earlier than the
    // oldest active one's own start.
    const inForceOnly = occasion === 'resume' && state.inForce !== undefined && (own === undefined || state.inForce < own);
    if (inForceOnly) ordinal = state.inForce;
    const keepEarlierAnchor = occasion === 'resume' && kept && state.inForce === undefined && own !== undefined;
    // The start in force from now: an ordinal known is kept as in force once
    // it is set (the anchor's fix reports it, subconsciousWindowFixed), not
    // before, so a set that fails leaves the record with the start the
    // strategy still has. While the start waits to be fixed, none is in
    // force until the fix reports it.
    if (kept && ordinal === undefined && state.inForce !== undefined) {
      const { inForce: _was, ...rest } = state;
      this.writeWindowState(rest);
    }
    const others: SubconsciousWindowStart[] = [];
    if (kept) {
      const bySequence = new Map<number, string[]>();
      for (const e of active) {
        if (e.sequence === sequence || state.starts[e.epochId] !== undefined) continue;
        bySequence.set(e.sequence, [...(bySequence.get(e.sequence) ?? []), e.epochId]);
      }
      for (const [at, ids] of bySequence) others.push({ sequence: at, epochIds: ids });
    }
    this.hooks.setSubconsciousAnchor({
      sequence,
      ...(ordinal !== undefined ? { ordinal } : {}),
      epochIds,
      ...(inForceOnly ? { inForceOnly: true as const } : {}),
      ...(keepEarlierAnchor ? { keepEarlierAnchor: true as const } : {}),
    }, others);
  }

  // ==========================================================================
  // Window starts (the subconscious's, by ordinal)
  // ==========================================================================

  /** Where each active tune-out's window start is kept, by ordinal: a snapshot state, on each branch its own. */
  private get windowStartsStateId(): string {
    return `subconscious/${this.hooks.primaryName() ?? 'default'}/window-starts`;
  }

  /** Whether the subconscious's window keeps ordinals, so its starts are kept (subconsciousWindowOrdinals). */
  private ordinalsKept(): boolean {
    try {
      return this.hooks.subconsciousName() != null && this.hooks.subconsciousWindowOrdinals?.() === true;
    } catch {
      return false;
    }
  }

  /**
   * Each tune-out's window start as an ordinal, by epoch id, as kept on the
   * store's branch now, and the start in force (`inForce`: the ordinal the
   * window start was last set to while a tune-out is active), which a
   * restart sets again (anchorSubconscious). A state that isn't this format
   * (`{ v: 1, starts, inForce? }`) reads as none kept, and is written over
   * at the next fix, with a line saying so. A read that throws answers null:
   * what is kept can't be told, so nothing is written over it (a fix isn't
   * kept, and is tried again at the next presentation), and the window
   * start isn't moved. A state an earlier version kept, with no `inForce`,
   * reads as one with none in force, and a restart sets the oldest active
   * tune-out's start, or the anchor the subconscious's strategy persisted
   * where that is earlier (keepEarlierAnchor).
   */
  private readWindowState(): WindowStartsState | null {
    let raw: unknown;
    try {
      raw = this.channelRegistry.readCoordinatorState(this.windowStartsStateId);
    } catch (err) {
      console.error(`[tune-out] the subconscious's window starts (${this.windowStartsStateId}) can't be read, so nothing is written over them now:`, err);
      return null;
    }
    if (raw == null) return { starts: {} };
    const state = raw as { v?: unknown; starts?: unknown; inForce?: unknown };
    if (state.v !== 1 || !state.starts || typeof state.starts !== 'object') {
      console.error(`[tune-out] the subconscious's window starts (${this.windowStartsStateId}) aren't in a form this version reads, so none is kept; the next fix writes over them`);
      return { starts: {} };
    }
    const isOrdinal = (o: unknown): o is number => typeof o === 'number' && Number.isInteger(o) && o >= 0;
    const starts: Record<string, number> = {};
    for (const [epochId, ordinal] of Object.entries(state.starts as Record<string, unknown>)) {
      if (isOrdinal(ordinal)) starts[epochId] = ordinal;
    }
    return { starts, ...(isOrdinal(state.inForce) ? { inForce: state.inForce } : {}) };
  }

  /** Keep `state`, answering whether it was written; a write that fails is logged, and the anchor the strategy holds stays as it is. */
  private writeWindowState(state: WindowStartsState): boolean {
    try {
      this.channelRegistry.writeCoordinatorState(this.windowStartsStateId, {
        v: 1,
        starts: state.starts,
        ...(state.inForce !== undefined ? { inForce: state.inForce } : {}),
      });
      return true;
    } catch (err) {
      console.error(`[tune-out] the subconscious's window starts (${this.windowStartsStateId}) couldn't be written, so a restart fixes them again:`, err);
      return false;
    }
  }

  /**
   * The framework fixed the subconscious's window start for `epochIds` at
   * `ordinal` (its index ordinal, #291): kept for each of them still active,
   * so a later anchor (another tune-out's enter, a restart) sets that
   * ordinal again rather than converting the tune-out's sequence anew, and
   * kept as the start in force while any tune-out is active, which a
   * restart sets again (anchorSubconscious), when it is the start in force
   * (`inForce`; another active tune-out's start fixed beside it isn't).
   * Answers whether it is kept, so that the anchor tries again at its next
   * presentation when it isn't: not when the record can't be read, which
   * is never written over then.
   */
  subconsciousWindowFixed(epochIds: readonly string[], ordinal: number, inForce = true): boolean {
    if (!this.ordinalsKept()) return true;
    const active = new Set(this.activeStarts().map((e) => e.epochId));
    const state = this.readWindowState();
    if (state === null) return false;
    let changed = false;
    for (const epochId of epochIds) {
      if (!active.has(epochId) || state.starts[epochId] === ordinal) continue;
      state.starts[epochId] = ordinal;
      changed = true;
    }
    // The window starts there now, whether or not the tune-outs it was fixed
    // for are active still (one cancelled before its start was fixed leaves
    // it in force, as any cancel does), while any tune-out is.
    if (inForce && active.size > 0 && state.inForce !== ordinal) {
      state.inForce = ordinal;
      changed = true;
    }
    return changed ? this.writeWindowState(state) : true;
  }

  /**
   * An ended tune-out's window start goes, and, once none is active, the
   * start in force with it: the next enter sets its own.
   */
  private forgetWindowStart(epochId: string): void {
    if (!this.ordinalsKept()) return;
    const state = this.readWindowState();
    // Unreadable: left as it is; a resume's prune takes the start out later.
    if (state === null) return;
    const noneActive = this.activeStarts().length === 0;
    if (!(epochId in state.starts) && !(noneActive && state.inForce !== undefined)) return;
    delete state.starts[epochId];
    if (noneActive) delete state.inForce;
    this.writeWindowState(state);
  }

  /** The window starts of tune-outs no longer active go. */
  private pruneWindowStarts(): void {
    if (!this.ordinalsKept()) return;
    const state = this.readWindowState();
    if (state === null) return;
    const active = new Set(this.activeStarts().map((e) => e.epochId));
    const stale = Object.keys(state.starts).filter((epochId) => !active.has(epochId));
    // With none active, no start is in force for the resume to set again.
    const staleInForce = active.size === 0 && state.inForce !== undefined;
    if (stale.length === 0 && !staleInForce) return;
    for (const epochId of stale) delete state.starts[epochId];
    if (staleInForce) delete state.inForce;
    this.writeWindowState(state);
  }

  private armExpiry(serverId: string, channelId: string, params: TuneOutParams): void {
    if (params.expiresAtMs === undefined) return;
    const key = this.key(serverId, channelId);
    const existing = this.expiryTimers.get(key);
    if (existing) clearTimeout(existing);
    const hold = (timer: ReturnType<typeof setTimeout>): void => { this.expiryTimers.set(key, timer); };
    const end = (): void => {
      try {
        // The retry is armed before the cancel, as the cadence arms its next
        // period before its turn, so a cancel that throws is tried again. A
        // cancel that ends the tune-out clears it with the channel's other
        // timers, and so does finding the tune-out already ended.
        hold(setTimeout(end, EXPIRY_RETRY_MS));
        if (!this.cancel(serverId, channelId, 'duration', 'duration elapsed').ok) {
          this.clearTimers(serverId, channelId);
        }
      } catch (err) {
        this.timerFailed('expiry', serverId, channelId, err);
      }
    };
    armAt(params.expiresAtMs, hold, end);
  }

  /** A timer callback's work threw. Report it on stderr and as a trace rather
   *  than throw it into the event loop, where an uncaught exception ends the
   *  host process. */
  private timerFailed(timer: 'cadence' | 'wake' | 'expiry', serverId: string, channelId: string, err: unknown): void {
    console.error(`[tune-out] the ${timer} timer for ${channelId} on ${serverId} failed:`, err);
    this.hooks.emitTrace({
      type: 'tune-out:timer-failed',
      timer,
      serverId,
      channelId,
      error: thrownReason(err),
    });
  }

  private listActive(): Array<{ serverId: string; channelId: string; params: TuneOutParams }> {
    const active: Array<{ serverId: string; channelId: string; params: TuneOutParams }> = [];
    for (const entry of this.channelRegistry.listChannelsRaw()) {
      const state = this.channelRegistry.getTuneOutState(entry.serverId, entry.descriptor.id);
      if (state) {
        active.push({ serverId: entry.serverId, channelId: entry.descriptor.id, params: state.params });
      }
    }
    return active;
  }

  // ==========================================================================
  // Enter / cancel
  // ==========================================================================

  /**
   * The options a tune-out call gives, read as numbers before anything
   * changes (F76). A tool's input reaches here as the model wrote it, and
   * the store can't keep a NaN or an Infinity: its append would throw after
   * the registry had marked the channel tuned out. So each option is read
   * as a number first, a numeric string included, as the sleep tool reads
   * its seconds; null counts as left out. A value that gives no finite
   * number is refused, naming the option and, where it can be left out,
   * what leaving it out means; so is a duration whose end time is too far
   * off to store. `now` is the clock the end time was counted from. One
   * rule for a channel's tune-out and the all-except hold.
   */
  private readOptions(
    opts: { cadenceSeconds?: unknown; backlogCap?: unknown; maxWakes?: unknown; durationSeconds?: unknown },
    leftOut: Record<TuneOutOption, string | null>,
  ): { ok: true; given: Partial<Record<TuneOutOption, number>>; now: number; expiresAtMs: number | undefined } | { ok: false; error: string } {
    const given: Partial<Record<TuneOutOption, number>> = {};
    for (const name of Object.keys(leftOut) as TuneOutOption[]) {
      const value: unknown = opts[name];
      if (value == null) continue;
      const n = Number(value);
      if (!Number.isFinite(n)) {
        const got = typeof value === 'number'
          ? String(value)
          : `${typeof value === 'string' ? 'the string' : 'the value'} ${JSON.stringify(value)}`;
        return {
          ok: false,
          error: `Nothing was tuned out: ${name} must be a finite number${name.endsWith('Seconds') ? ' of seconds' : ''}, `
            + `and it was ${got}.${leftOut[name] ? ` Leave it out ${leftOut[name]}.` : ''}`,
        };
      }
      given[name] = n;
    }
    const now = Date.now();
    const expiresAtMs = given.durationSeconds === undefined
      ? undefined
      : now + Math.max(60, given.durationSeconds) * 1000;
    if (expiresAtMs !== undefined && !Number.isFinite(expiresAtMs)) {
      return {
        ok: false,
        error: `Nothing was tuned out: durationSeconds ${given.durationSeconds} is longer than an end time can be kept.`
          + (leftOut.durationSeconds ? ` Leave it out ${leftOut.durationSeconds}.` : ''),
      };
    }
    return { ok: true, given, now, expiresAtMs };
  }

  enter(
    serverId: string,
    channelId: string,
    opts: { cadenceSeconds?: unknown; backlogCap?: unknown; maxWakes?: unknown; durationSeconds?: unknown },
    source: string,
  ): { ok: true; params: TuneOutParams } | { ok: false; error: string; alreadyTunedOut?: true } {
    // No reader: no hold. One nothing summarizes would hand the resident an
    // undated backlog all at once when it ends.
    if (!this.readerAvailable()) return { ok: false, error: NO_READER_REFUSAL };
    if (this.hooks.isForkBound({ serverId, channelId })) {
      return {
        ok: false,
        error: `Nothing changed: a conversation is bound to ${this.quotedShown(serverId, channelId)}, so its messages go to that `
          + "conversation, and tune_out won't divert a channel while one is. Calling tune_out on it again won't change "
          + 'that until the conversation ends, which happens only once the channel has been quiet for a while. Tune '
          + 'out a different channel, or ask whoever runs this host if this one should be diverted.',
      };
    }
    const current = this.channelRegistry.getTuneOutState(serverId, channelId);
    if (current) return { ok: false, error: alreadyTunedOutText(this.quotedShown(serverId, channelId), current.params), alreadyTunedOut: true };
    const scope = this.getAllExcept();
    if (scope && scope.params.except.serverId === serverId && scope.params.except.channelId === channelId) {
      return { ok: false, error: `channel ${this.quotedShown(serverId, channelId)} is the excepted channel of the active all-except hold; cancel that first` };
    }
    const read = this.readOptions(opts, {
      durationSeconds: 'to stay tuned out until you cancel',
      cadenceSeconds: `for the default, ${TUNE_OUT_DEFAULTS.cadenceSeconds}`,
      backlogCap: `for the default, ${TUNE_OUT_DEFAULTS.backlogCap}`,
      maxWakes: `for the default, ${TUNE_OUT_DEFAULTS.maxWakes}`,
    });
    if (!read.ok) return read;
    const { given, expiresAtMs } = read;
    const params: TuneOutParams = {
      epochId: randomUUID(),
      cadenceSeconds: Math.max(30, given.cadenceSeconds ?? TUNE_OUT_DEFAULTS.cadenceSeconds),
      backlogCap: Math.max(0, given.backlogCap ?? TUNE_OUT_DEFAULTS.backlogCap),
      maxWakes: Math.max(1, given.maxWakes ?? TUNE_OUT_DEFAULTS.maxWakes),
      startedAtSequence: this.hooks.currentSequence(),
      ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    };
    // A tune-out that ended in the registry without this coordinator's
    // cancel would have left its timers armed: clear them, so none of them
    // acts on this one.
    this.clearTimers(serverId, channelId);
    this.channelRegistry.enterTuneOut(serverId, channelId, params, source);
    this.armExpiry(serverId, channelId, params);

    // Window anchor: start of the OLDEST active tune-out. Never move the
    // anchor forward here — an older active epoch owns it.
    this.anchorSubconscious();

    this.divertedSinceInvocation.set(this.key(serverId, channelId), 0);
    if (this.readerAvailable()) this.startCadence(serverId, channelId, params.cadenceSeconds);
    this.hooks.emitTrace({
      type: 'tune-out:entered', serverId, channelId, epochId: params.epochId, reader: this.readerAvailable(),
    });
    return { ok: true, params };
  }

  /** Whether the framework keeps writes in memory now (writesHeld); a hook that throws counts as not. */
  private writesHeldNow(): boolean {
    try {
      return this.hooks.writesHeld?.() === true;
    } catch (err) {
      console.error('[tune-out] could not ask whether writes are held in memory, so a cancel goes on:', err);
      return false;
    }
  }

  /**
   * Keep a cancel asked for while writes are kept in memory, for
   * runDeferredCancels, with its note, for the epoch it was asked for
   * (`target`). The first one asked for a hold stands, with its reason and
   * source. A later one for the same hold (an end time's retry, a wake past
   * the budget, an agent's cancel) adds nothing, except a note: the waiting
   * cancel takes it, with its author, when it has none, and otherwise the
   * later note is dropped, with a log line, and this answers 'note-dropped'
   * so its caller can be told. One waiting for an earlier epoch there,
   * whose hold ended without it, is dropped (dropDeferred), and this one
   * waits in its place.
   */
  private deferCancel(
    key: string,
    target: DeferredFor,
    what: string,
    run: (queued: DeferredCancel) => void,
    note: string | undefined,
    noteAuthor: string | undefined,
  ): 'waits' | 'note-dropped' {
    let waiting = this.deferredCancels.get(key);
    if (waiting && waiting.for.epochId !== target.epochId) {
      this.deferredCancels.delete(key);
      this.dropDeferred(waiting, { reason: 'hold-ended', current: target.epochId });
      waiting = undefined;
    }
    if (!waiting) {
      this.deferredCancels.set(key, {
        for: target, what, run,
        ...(note !== undefined ? { note } : {}), ...(noteAuthor !== undefined ? { noteAuthor } : {}),
      });
      console.error(`[tune-out] the cancel of ${what} waits until the store takes writes again (an operator's change to it is in progress, or a context it writes to refuses writes until it is re-initialized), so that its release is stored before the tune-out's end is recorded`);
      return 'waits';
    }
    if (note === undefined) return 'waits';
    if (waiting.note === undefined) {
      waiting.note = note;
      if (noteAuthor !== undefined) waiting.noteAuthor = noteAuthor;
      return 'waits';
    }
    console.error(`[tune-out] a later cancel of ${what} is dropped with its note: the cancel already waiting carries a note of its own`);
    return 'note-dropped';
  }

  /**
   * Run the cancels asked for while writes were kept in memory (deferCancel),
   * in the order asked, now that the framework stores them again: it calls
   * this once a surgery's release has stored what its hold kept, or told of
   * what it couldn't store, and the retry timer calls it. One whose writes
   * are still held waits on. One whose epoch no longer holds (its hold
   * ended without it, and a later one may hold there now) is dropped, told
   * (dropDeferred): it ends nothing, a later hold included. One that throws
   * (its release couldn't be made durable, a store operation threw) stays
   * waiting, with its note, the tune-out still in force: it runs again at
   * the next call, or EXPIRY_RETRY_MS later, which one timer arms; one that
   * threw after it recorded its hold's end isn't kept, and a note it hadn't
   * delivered by then is told lost (dropDeferred). First, the loss notices
   * not written yet are tried again (writeLossNotices); the retry is armed
   * while one is left. Never throws.
   */
  runDeferredCancels(): void {
    if ((this.deferredCancels.size === 0 && this.lossNotices.size === 0 && !this.markerPending) || this.writesHeldNow()) return;
    if (this.deferredRetry !== undefined) {
      clearTimeout(this.deferredRetry);
      this.deferredRetry = undefined;
    }
    this.writePendingMarker();
    this.writeLossNotices();
    const runs = [...this.deferredCancels.entries()];
    this.deferredCancels.clear();
    let failed = false;
    for (const [key, entry] of runs) {
      try {
        const now = entry.for.current();
        if (now !== entry.for.epochId) {
          this.dropDeferred(entry, { reason: 'hold-ended', current: now });
          continue;
        }
        entry.run(entry);
      } catch (err) {
        // The end is recorded before what follows it in a release, so a run
        // whose epoch no longer holds ended it, and failed after: it isn't
        // kept, or its retry would act on whatever holds there next. One
        // whose epoch can't be read is kept, as one still in force.
        let ended: boolean;
        try {
          ended = entry.for.current() !== entry.for.epochId;
        } catch {
          ended = false;
        }
        if (ended) {
          console.error(`[tune-out] the cancel of ${entry.what}, asked for while writes were held in memory, ended its tune-out (epoch ${entry.for.epochId}) when it ran, but a step after the end failed:`, err);
          // The run delivers its note after the end, told lost where it
          // can't be (deliverQueuedNote): a step that failed before then
          // left it neither.
          if (entry.note !== undefined && !entry.noteSettled) {
            this.dropDeferred(entry, { reason: 'note-undelivered', by: 'itself', error: thrownReason(err) });
          }
          continue;
        }
        failed = true;
        // A run that waited again (deferCancel, its writes held once more)
        // has its entry back already: its note is taken there when it has none.
        const waiting = this.deferredCancels.get(key);
        if (!waiting) {
          this.deferredCancels.set(key, entry);
        } else if (waiting.for.epochId !== entry.for.epochId) {
          this.dropDeferred(entry, { reason: 'hold-ended', current: waiting.for.epochId });
        } else if (waiting.note === undefined && entry.note !== undefined) {
          waiting.note = entry.note;
          if (entry.noteAuthor !== undefined) waiting.noteAuthor = entry.noteAuthor;
        }
        console.error(`[tune-out] a cancel asked for while writes were held in memory failed when it ran, so it stays waiting, the tune-out in force, and is tried again in ${EXPIRY_RETRY_MS / 1000} s or at the next release:`, err);
      }
    }
    if (failed || this.lossNotices.size > 0 || this.markerPending) this.armDeferredRetry();
  }

  /**
   * A deferred cancel taken off the queue without what it was for being
   * done (`drop`, DeferredDrop), told on stderr and as a trace
   * (`tune-out:deferred-cancel-dropped`) with the epoch it was asked for. A
   * note it carried is lost: the trace names its author (noteAuthorOf), and
   * the author is told so in its own context where it still exists, a
   * reader fork whose run has ended being written nothing (tellNoteLost),
   * unless the release of the cancel that ended the hold tells it already
   * (`told` release, queuedNoteFirst): no second notice is written then.
   */
  private dropDeferred(entry: DeferredCancel, drop: DeferredDrop, told: 'notice' | 'release' = 'notice'): void {
    const { epochId, serverId, channelId, scope } = entry.for;
    const noteLost = entry.note !== undefined;
    const author = noteLost ? this.noteAuthorOf(entry) : undefined;
    if (drop.reason === 'hold-ended') {
      const current = drop.current;
      console.error(`[tune-out] the cancel of ${entry.what}, asked for while writes were held in memory for epoch ${epochId}, is dropped: `
        + `that epoch's hold ended without it${current !== undefined ? `, and epoch ${current} holds there now, which it was not asked for` : ''}, `
        + `so it ends nothing${noteLost ? ', and the note it carried is not delivered' : ''}`);
    } else if (drop.reason === 'stopped') {
      console.error(`[tune-out] stopping: the cancel of ${entry.what}, asked for while writes were held in memory for epoch ${epochId}, `
        + `ends nothing, the tune-out staying in force on disk, and the note${author !== undefined ? ` ${author} left` : ''} with it is not delivered`);
    } else {
      console.error(`[tune-out] the note${author !== undefined ? ` ${author} left with` : ' carried by'} the cancel of ${entry.what}, asked for while writes were held in memory for epoch ${epochId}, `
        + `is lost: ${drop.by === 'another' ? 'another cancel' : 'that cancel itself, when it ran,'} ended that hold, and the note could not be delivered: ${drop.error}`
        + (told === 'release' ? '; the release of the cancel that ended it says so' : ''));
    }
    this.hooks.emitTrace({
      type: 'tune-out:deferred-cancel-dropped', serverId, channelId, epochId,
      ...(scope ? { scope } : {}),
      reason: drop.reason,
      ...(drop.reason === 'hold-ended' && drop.current !== undefined ? { currentEpochId: drop.current } : {}),
      noteLost,
      ...(author !== undefined ? { noteAuthor: author } : {}),
      ...(drop.reason === 'note-undelivered' ? { error: drop.error } : {}),
    });
    if (noteLost) {
      entry.noteSettled = true;
      if (told === 'notice') this.tellNoteLost(entry, author, drop);
    }
  }

  /**
   * Whose a queued cancel's note is: the name deliverReaderNote would
   * deliver it under, the persistent subconscious's, else the reader fork's
   * that left it (`noteAuthor`). Undefined where neither is known; the
   * fork's name where the subconscious's can't be read.
   */
  private noteAuthorOf(entry: DeferredCancel): string | undefined {
    try {
      return this.hooks.subconsciousName() ?? entry.noteAuthor;
    } catch {
      return entry.noteAuthor;
    }
  }

  /**
   * The author of a queued cancel's lost note (`author`, noteAuthorOf), told
   * in its own context that the note was not delivered and why (`drop`):
   * its cancel was answered as waiting, so nothing else tells it. The
   * notice is kept (lossNotices) and written now (writeLossNotices). One
   * whose write fails stays kept, its first failure traced, and is tried
   * again at the next release and at the retry, which this arms, until it
   * is written; what dropped the cancel goes on either way. One for the
   * persistent subconscious is kept in the store as well (writeLossRecord),
   * so a stop leaves it for the next boot to write (restoreLossNotices); a
   * reader fork's is lost at a stop, as the fork's run is. While writes are
   * held it waits for their release, as the cancels do. A reader fork that
   * has ended is no agent the framework writes to any more: it is written
   * nothing, the loss reaching no one, which is traced (writeLossNotice),
   * and the trace of the drop (dropDeferred) still names the fork. An
   * author not known is logged. One told at the stop is kept, not written:
   * the stop keeps it in the store with the others (writeLossRecord), for
   * the next boot. Where the store refuses that record too, the stop's
   * stamp leaves the hold out (writeStopStamp), and the next boot tells the
   * subconscious, for a hold still on record, what that run's rows show of
   * a cancel of it then waiting (noteUnstampedStop); a stop that can't write
   * its stamp either leaves the one this run's boot wrote, which covers no
   * hold, so the next boot tells it the same, where that one landed. Where
   * the store refused every one, this run's too, nothing in the store says
   * the stop came: the next boot reads no stamp as a first start (#844
   * round 8, Weft) and tells nothing. Where every
   * write refuses through the stop (the note, the notice, the store's
   * record) and no release carries the loss (queuedNoteFirst), for a hold
   * that has ended, the trace of the drop, with that of the notice's
   * failure, and the log are all that is left of it: nothing else here
   * outlives the stop.
   */
  private tellNoteLost(entry: DeferredCancel, author: string | undefined, drop: DeferredDrop): void {
    if (author === undefined) {
      console.error(`[tune-out] the note carried by the cancel of ${entry.what} is lost, and no author of it is known here, so none is told`);
      return;
    }
    const { epochId, serverId, channelId, scope, current } = entry.for;
    // In persistent mode the author is the subconscious (noteAuthorOf), and
    // no reader fork is configured; with reader forks, a fork.
    let persistent: boolean;
    try {
      persistent = this.hooks.subconsciousName() === author;
    } catch {
      persistent = typeof this.hooks.invokeReader !== 'function';
    }
    const notice: LossNotice = {
      id: randomUUID(),
      for: { epochId, serverId, channelId, ...(scope ? { scope } : {}), current },
      what: entry.what, drop, keptAtMs: Date.now(),
      ...(persistent ? { persistent: true as const } : {}),
    };
    const kept = this.lossNotices.get(author);
    if (kept) kept.push(notice);
    else this.lossNotices.set(author, [notice]);
    if (this.stopped) return;
    this.writeLossNotices(author);
    if (this.lossNotices.size > 0) this.armDeferredRetry();
  }

  /**
   * Write the loss notices kept (lossNotices), `author`'s or every
   * author's, each author's in the order its losses came: one written, or
   * whose author has ended, leaves the queue; one whose write fails stays
   * for the next try (writeLossNotice). None is written while writes are
   * held (writesHeld): the framework would keep it in memory and answer an
   * empty id, which then couldn't tell a kept write from an ended author's
   * dropped one. The release or the retry writes them. Then the store's
   * record of the persistent subconscious's kept notices is brought in
   * line (writeLossRecord). Never throws.
   */
  private writeLossNotices(author?: string): void {
    for (const name of author !== undefined ? [author] : [...this.lossNotices.keys()]) {
      const kept = this.lossNotices.get(name);
      if (!kept) continue;
      // Off the map while they are written: a loss told meanwhile is kept
      // after them, not written over.
      this.lossNotices.delete(name);
      const left = kept.filter((notice) => this.writesHeldNow() || this.writeLossNotice(name, notice) === 'failed');
      const since = this.lossNotices.get(name) ?? [];
      if (left.length + since.length > 0) this.lossNotices.set(name, [...left, ...since]);
    }
    this.writeLossRecord();
  }

  /** Where the persistent subconscious's kept loss notices are kept: a snapshot state, beside the coordinator's others. */
  private get lossNoticesStateId(): string {
    return `tune-out/${this.hooks.primaryName() ?? 'default'}/loss-notices`;
  }

  /** The persistent subconscious's kept notices (lossNotices) in the record's form, in the order kept. */
  private persistedLossNotices(): PersistedLossNotice[] {
    const out: PersistedLossNotice[] = [];
    for (const [author, kept] of this.lossNotices) {
      for (const notice of kept) {
        if (!notice.persistent) continue;
        const { epochId, serverId, channelId, scope } = notice.for;
        const { drop } = notice;
        out.push({
          id: notice.id, author, what: notice.what,
          for: { epochId, serverId, channelId, ...(scope ? { scope } : {}) },
          drop: drop.reason === 'hold-ended'
            ? { reason: 'hold-ended', ...(drop.current !== undefined ? { current: drop.current } : {}) }
            : drop.reason === 'stopped'
              ? { reason: 'stopped' }
              : drop.reason === 'unstamped-stop'
                ? { ...drop }
                : { reason: 'note-undelivered', by: drop.by, error: drop.error },
          keptAtMs: notice.keptAtMs,
          ...(notice.keptAtSequence !== undefined ? { keptAtSequence: notice.keptAtSequence } : {}),
          ...(notice.traced ? { traced: true as const } : {}),
        });
      }
    }
    return out;
  }

  /**
   * Keep the persistent subconscious's kept loss notices in the store
   * (`tune-out/<primary>/loss-notices`, PersistedLossNotice), as they are
   * in memory: one kept is added, one written leaves. Only when they
   * changed since the record was last written or read, or a write of it
   * failed; never while writes are held (writesHeld): the release, the
   * retry or the stop writes it then. Not over a record that couldn't be
   * read (readLossRecord, tried again first). A write that fails is logged,
   * and the notices stay kept in memory, written or tried again as before;
   * a stop meanwhile loses them. At `stop`, written whenever one is kept,
   * held writes or not, and answers whether the record holds them. At
   * `boot`, written where they changed, held writes or not, as the boot's
   * stamp is (noteUnstampedStop). Never throws.
   */
  private writeLossRecord(at?: 'stop' | 'boot'): boolean {
    try {
      const notices = this.persistedLossNotices();
      const shape = JSON.stringify(notices);
      if (at !== 'stop' && shape === this.lossRecordShape && !this.lossRecordStale) return true;
      if (at === 'stop' && notices.length === 0 && !this.lossRecordStale && !this.lossRecordUnread) return true;
      if (at === undefined && this.writesHeldNow()) {
        this.lossRecordStale = true;
        return false;
      }
      if (this.lossRecordUnread && !this.readLossRecord()) {
        this.lossRecordStale = true;
        console.error(`[tune-out] the loss notices kept for the subconscious (${this.lossNoticesStateId}) can't be read, so they aren't written over: `
          + `${notices.length === 0 ? 'none is' : `${notices.length} kept now ${notices.length === 1 ? 'is' : 'are'}`} not added to them`);
        return false;
      }
      // Read again just now (readLossRecord): what it kept is in memory too.
      const all = this.persistedLossNotices();
      this.channelRegistry.writeCoordinatorState(this.lossNoticesStateId, { v: 1, pendingLossNotices: all });
      this.lossRecordShape = JSON.stringify(all);
      this.lossRecordStale = false;
      return true;
    } catch (err) {
      this.lossRecordStale = true;
      console.error(`[tune-out] the loss notices kept for the subconscious (${this.lossNoticesStateId}) couldn't be written to the store, `
        + `so they are kept in memory only${at === 'stop' ? ', which the stop clears' : ', and a stop before they are written loses them'}: ${thrownReason(err)}`);
      return false;
    }
  }

  /**
   * Read the persistent subconscious's kept loss notices from the store
   * (writeLossRecord) into memory (lossNotices), ahead of any kept since for
   * the same author: at boot (restoreLossNotices), and before the record is
   * written where it couldn't be read before. Answers whether it was read.
   * One that throws is logged and answers false: nothing is written over it
   * until it is read. A record not in this format (`{ v: 1,
   * pendingLossNotices }`) reads as none kept, logged, and is written over
   * at the next change; an entry this version can't read is logged and left
   * out, so the next write drops it.
   */
  private readLossRecord(): boolean {
    let raw: unknown;
    try {
      raw = this.channelRegistry.readCoordinatorState(this.lossNoticesStateId);
    } catch (err) {
      this.lossRecordUnread = true;
      console.error(`[tune-out] the loss notices kept for the subconscious (${this.lossNoticesStateId}) can't be read, so none is written now, `
        + `and nothing is written over them until they can be read: ${thrownReason(err)}`);
      return false;
    }
    this.lossRecordUnread = false;
    if (raw == null) return true;
    const record = raw as { v?: unknown; pendingLossNotices?: unknown };
    if (record.v !== 1 || !Array.isArray(record.pendingLossNotices)) {
      console.error(`[tune-out] the loss notices kept for the subconscious (${this.lossNoticesStateId}) aren't in a form this version reads, so none is written; the next change writes over them`);
      return true;
    }
    const known = new Set([...this.lossNotices.values()].flat().map((n) => n.id));
    const restored = new Map<string, LossNotice[]>();
    let unreadable = 0;
    for (const value of record.pendingLossNotices) {
      const entry = readPersistedLossNotice(value);
      if (!entry) {
        unreadable++;
        continue;
      }
      if (known.has(entry.id)) continue;
      known.add(entry.id);
      const { epochId, serverId, channelId, scope } = entry.for;
      const notice: LossNotice = {
        id: entry.id,
        for: { epochId, serverId, channelId, ...(scope ? { scope } : {}), current: this.epochHoldingAt(serverId, channelId, scope) },
        what: entry.what, drop: entry.drop, keptAtMs: entry.keptAtMs, persistent: true,
        ...(entry.keptAtSequence !== undefined ? { keptAtSequence: entry.keptAtSequence } : {}),
        ...(entry.traced ? { traced: true as const } : {}),
      };
      restored.set(entry.author, [...(restored.get(entry.author) ?? []), notice]);
    }
    for (const [author, notices] of restored) this.lossNotices.set(author, [...notices, ...(this.lossNotices.get(author) ?? [])]);
    if (unreadable > 0) {
      console.error(`[tune-out] ${unreadable} of the loss notices kept for the subconscious (${this.lossNoticesStateId}) can't be read by this version, `
        + 'so they are not written, and the next write of the record leaves them out');
    }
    // What the store holds, so the next write is made when memory differs:
    // at once where an entry was left out.
    this.lossRecordShape = unreadable > 0 ? '' : JSON.stringify(this.persistedLossNotices());
    return true;
  }

  /** The epoch holding where a kept notice's cancel was (DeferredFor's `current`): the channel's tune-out, or the all-except hold. */
  private epochHoldingAt(serverId: string, channelId: string, scope?: 'all-except'): () => string | undefined {
    return scope === 'all-except'
      ? () => this.getAllExcept()?.params.epochId
      : () => this.channelRegistry.getTuneOutState(serverId, channelId)?.params.epochId;
  }

  /**
   * The holds on record, a channel's and the all-except hold (its excepted
   * channel, with `scope`): the registry's record of each channel's, whether
   * or not the channel is registered yet, as at boot it isn't
   * (tuneOutsOnRecord; the registered ones, listActive, where the registry
   * has no such list). May throw.
   */
  private holdsOnRecord(): HoldOnRecord[] {
    const registry = this.channelRegistry as Partial<Pick<ChannelRegistry, 'tuneOutsOnRecord'>>;
    const channels = typeof registry.tuneOutsOnRecord === 'function'
      ? registry.tuneOutsOnRecord.call(this.channelRegistry)
      : this.listActive();
    const held = this.getAllExcept();
    return [
      ...channels.filter(({ params }) => typeof params.epochId === 'string')
        .map(({ serverId, channelId, params }) => ({
          epochId: params.epochId, serverId, channelId,
          ...(typeof params.startedAtSequence === 'number' ? { startedAt: params.startedAtSequence } : {}),
        })),
      ...(held ? [{
        epochId: held.params.epochId, serverId: held.params.except.serverId, channelId: held.params.except.channelId, scope: 'all-except' as const,
        ...(typeof held.params.startedAtSequence === 'number' ? { startedAt: held.params.startedAtSequence } : {}),
      }] : []),
    ];
  }

  /** Where the last stop's stamp is kept (StopStamp): a snapshot state, beside the loss notices. */
  private get stopStampStateId(): string {
    return `tune-out/${this.hooks.primaryName() ?? 'default'}/stop-stamp`;
  }

  /**
   * At the stop, once the loss notices are written or kept: the stamp
   * (StopStamp) naming the holds on record now, a channel's and the
   * all-except hold, whose waiting cancels this stop accounted for. Left
   * out are the epochs of a note whose loss couldn't be kept (`unaccounted`;
   * every persistent notice's where the store refused the record,
   * `recorded` false), so the next boot tells the subconscious of them
   * (noteUnstampedStop). A stamp the store refuses too is logged: nothing
   * more can be done at the stop. The next boot then finds this run's own
   * stamp, covering no hold, where it landed, and tells the subconscious of
   * each hold; where the store refused that too, it finds none, which it
   * reads as a first start, and tells nothing. Never throws.
   */
  private writeStopStamp(recorded: boolean, unaccounted: Set<string>): void {
    try {
      if (!recorded) {
        for (const kept of this.lossNotices.values()) {
          for (const notice of kept) if (notice.persistent) unaccounted.add(notice.for.epochId);
        }
      }
      const onRecord = this.holdsOnRecord().map((hold) => hold.epochId);
      const stamp: StopStamp = {
        v: 1, epochs: onRecord.filter((epochId) => !unaccounted.has(epochId)),
        ...(this.runStartedAt !== undefined ? { runStartedAt: this.runStartedAt } : {}),
      };
      this.channelRegistry.writeCoordinatorState(this.stopStampStateId, stamp);
    } catch (err) {
      console.error(`[tune-out] stopping: the stop could not be stamped (${this.stopStampStateId}), so the next boot tells the subconscious, `
        + `for each hold still on record, what it finds of a cancel of it waiting now, where this run's own stamp landed; `
        + `${this.markerPending ? 'it did not either, so nothing will' : 'it did'}: ${thrownReason(err)}`);
    }
  }

  /**
   * At boot (resumeActiveEpochs), for the holds on record (`onRecord`, read
   * before any is resumed or ended): those the last stop's stamp doesn't
   * cover (writeStopStamp; after a crash the stamp is the one the boot
   * before wrote, covering none; one the store refused at a stop is that
   * boot's too) may have had a cancel waiting, with a note, which that stop
   * didn't account for. No stamp at all is a first boot on this version
   * (every boot writes one), not a crash: every hold counts as covered. A
   * hold whose waiting cancel's loss the stop kept in the store
   * (`stopKept`, restoreLossNotices) is accounted for. For the others, the
   * rows from that run on (the stamp's `runStartedAt`) say what they can
   * (UnstampedStop): a release that told the queued note's loss
   * (`lostNote`, queuedNoteFirst) needs nothing more; a release of that
   * epoch stored since the cancel was asked (or since the hold and the run
   * began) is `ran`; a note of that epoch delivered with no release since,
   * `delivered`; the subconscious's own `cancel_tuneout` of it answered as
   * waiting (askedCancelOf), `asked`; else `unknown`, told conditionally.
   * Each by a loss notice (`unstamped-stop`) kept and written as the others
   * are (writeLossNotices), with a turn to read it, kept in the store and
   * tried again where the store still refuses; traced as
   * `tune-out:stop-unrecorded` with what was `found`. A hold already told so
   * (its notice in the subconscious's window, or kept to be written) is told
   * again only what says more (FOUND_RANK), or another note. A reader fork
   * is told nothing: none outlives the stop. The stamp is then written again
   * covering no hold and naming this run's start (`runStartedAt`), so it
   * can't cover a later stop and a crash during this run leaves it so; a
   * write that fails is kept and tried again as the loss notices are
   * (writePendingMarker), and meanwhile a waiting cancel's answer says so.
   * A stamp that can't be read, or isn't in this version's form, covers
   * nothing. Never throws.
   */
  private noteUnstampedStop(onRecord: readonly HoldOnRecord[], stopKept: ReadonlySet<string>, bootHead: number | undefined): void {
    try {
      let raw: unknown;
      let readable = true;
      try {
        raw = this.channelRegistry.readCoordinatorState(this.stopStampStateId);
      } catch (err) {
        readable = false;
        console.error(`[tune-out] the last stop's stamp (${this.stopStampStateId}) can't be read, so it covers no hold: ${thrownReason(err)}`);
      }
      const stamp = raw as Partial<StopStamp> | null | undefined;
      const covered = new Set<string>();
      let since: number | undefined;
      const firstBoot = readable && raw == null;
      if (stamp && stamp.v === 1 && Array.isArray(stamp.epochs)) {
        for (const epochId of stamp.epochs) if (typeof epochId === 'string') covered.add(epochId);
        if (typeof stamp.runStartedAt === 'number') since = stamp.runStartedAt;
      } else if (raw != null) {
        console.error(`[tune-out] the last stop's stamp (${this.stopStampStateId}) isn't in a form this version reads, so it covers no hold`);
      }
      if (firstBoot && onRecord.length > 0) {
        console.error(`[tune-out] no stop stamp is kept (${this.stopStampStateId}): a first start on a version that stamps its stops, `
          + 'so the holds on record count as stopped cleanly');
      }
      // This run begins at the store's head as the boot found it, before
      // the boot's own releases (an end time passed, a wake budget spent):
      // those are this run's, not the last one's.
      this.runStartedAt = bootHead;
      this.markerPending = { v: 1, epochs: [], ...(this.runStartedAt !== undefined ? { runStartedAt: this.runStartedAt } : {}) };
      this.writePendingMarker();
      if (this.markerPending) this.armDeferredRetry();
      let author: string | null;
      try {
        author = this.hooks.subconsciousName();
      } catch {
        author = null;
      }
      if (!author || firstBoot) return;
      const uncovered = onRecord.filter((hold) => !covered.has(hold.epochId));
      if (uncovered.length === 0) return;
      // What that run's residents' rows show, by epoch: from its start to
      // this boot's (`bootHead`), so a release this boot made isn't read as
      // the last run's.
      const notes = new Map<string, number>();
      const releases = new Map<string, Array<{ sequence: number; source?: string; reason?: string; by?: string }>>();
      const toldInRelease = new Set<string>();
      try {
        for (const m of this.hooks.getStoredMessages()) {
          if (since !== undefined && typeof m.sequence === 'number' && m.sequence <= since) continue;
          if (bootHead !== undefined && typeof m.sequence === 'number' && m.sequence > bootHead) continue;
          const meta = m.metadata as { kind?: unknown; epochId?: unknown; lostNote?: unknown; cancel?: { source?: unknown; reason?: unknown; by?: unknown } } | undefined;
          if (typeof meta?.epochId !== 'string') continue;
          if (meta.kind === 'subconscious-note') notes.set(meta.epochId, Math.max(notes.get(meta.epochId) ?? -Infinity, m.sequence));
          else if (meta.kind === 'tune-out-cancel') {
            if (meta.lostNote === true) toldInRelease.add(meta.epochId);
            releases.set(meta.epochId, [...(releases.get(meta.epochId) ?? []), {
              sequence: m.sequence,
              ...(typeof meta.cancel?.source === 'string' ? { source: meta.cancel.source } : {}),
              ...(typeof meta.cancel?.reason === 'string' ? { reason: meta.cancel.reason } : {}),
              ...(typeof meta.cancel?.by === 'string' ? { by: meta.cancel.by } : {}),
            }]);
          }
        }
      } catch (err) {
        console.error(`[tune-out] the residents' rows could not be read at boot, so what became of a note waiting at the last stop isn't known: ${thrownReason(err)}`);
      }
      // What the subconscious's own window shows: its calls, and what it was told already.
      let window: readonly WindowRow[] = [];
      try {
        window = this.hooks.subconsciousWindow?.() ?? [];
      } catch (err) {
        console.error(`[tune-out] the subconscious's window could not be read at boot, so a cancel it asked for isn't named: ${thrownReason(err)}`);
      }
      let archived: ReadonlyMap<string, unknown> | undefined;
      try {
        archived = this.hooks.subconsciousGuardedResults?.();
      } catch (err) {
        console.error(`[tune-out] the tool-result guard's audit could not be read at boot, so a result it withheld isn't read from it: ${thrownReason(err)}`);
      }
      const asks = cancelAsksIn(window, author, archived);
      // What it was told of a hold's unrecorded stop already, and when: by
      // the store's head when the boot that told it decided it
      // (keptAtSequence), on its row or on a notice kept to be written; a
      // row with none by its own sequence, a kept notice with none as told
      // now. A notice written late, its writes held, was told then.
      const toldBefore = (epochId: string): Array<{ found: UnstampedStop['found']; note?: string; at: number }> => [
        ...window.flatMap((m) => {
          const meta = m.metadata as { kind?: unknown; epochId?: unknown; stopUnrecorded?: { found?: unknown; note?: unknown; keptAtSequence?: unknown } } | undefined;
          if (meta?.kind !== 'tune-out-note-undelivered' || meta.epochId !== epochId || !meta.stopUnrecorded) return [];
          const found = meta.stopUnrecorded.found;
          return found === 'delivered' || found === 'ran' || found === 'asked' || found === 'unknown'
            ? [{
              found: found as UnstampedStop['found'], ...(typeof meta.stopUnrecorded.note === 'string' ? { note: meta.stopUnrecorded.note } : {}),
              at: typeof meta.stopUnrecorded.keptAtSequence === 'number' ? meta.stopUnrecorded.keptAtSequence : m.sequence,
            }] : [];
        }),
        ...(this.lossNotices.get(author) ?? []).flatMap((n) => (n.drop.reason === 'unstamped-stop' && n.for.epochId === epochId
          ? [{ found: n.drop.found, ...(n.drop.note !== undefined ? { note: n.drop.note } : {}), at: n.keptAtSequence ?? Infinity }] : [])),
      ];
      for (const hold of uncovered) {
        const { epochId, serverId, channelId, scope } = hold;
        const what = scope ? `the all-except hold (epoch ${epochId})` : `the tune-out of ${this.shown(serverId, channelId)} (epoch ${epochId})`;
        if (toldInRelease.has(epochId)) {
          console.error(`[tune-out] the last stop did not record the state of ${what}, but a release of it already told ${author} that its waiting note was lost`);
          continue;
        }
        if (stopKept.has(epochId)) {
          console.error(`[tune-out] the last stop's stamp doesn't cover ${what}, but the stop kept the loss of its waiting note in the store, which is told`);
          continue;
        }
        const asked = this.askedCancelOf(hold, since, asks, onRecord);
        // With no ask found, a release of the epoch in that run is after the
        // hold and the run began by construction (an epoch's release follows
        // its entry, and the rows are that run's), so this bound can't be
        // told from none by any store; it is kept for the reading's sake.
        const after = asked ? asked.sequence : Math.max(hold.startedAt ?? -Infinity, since ?? -Infinity);
        const ranAfter = (releases.get(epochId) ?? []).filter((r) => r.sequence > after);
        // The subconscious's own cancel: one its tool asked for (`subconscious`)
        // under its own name, or under none; a reader fork's, under the
        // fork's, is another's, as anyone else's is.
        const own = ranAfter.some((r) => r.source === 'subconscious' && (r.by === undefined || r.by === author));
        // Credited to the latest that ran.
        const by = own ? undefined : ranAfter.at(-1);
        const noteAt = notes.get(epochId);
        const drop: UnstampedStop = ranAfter.length > 0
          ? {
            reason: 'unstamped-stop', found: 'ran', ...(asked ? { asked: true as const } : {}),
            ...(asked?.note !== undefined ? { note: asked.note } : {}), ...(noteAt !== undefined ? { noteDelivered: true as const } : {}),
            ...(own ? { own: true as const } : by?.reason !== undefined ? { ranBy: by.reason } : {}),
          }
          : noteAt !== undefined ? { reason: 'unstamped-stop', found: 'delivered' }
          : asked ? { reason: 'unstamped-stop', found: 'asked', ...(asked.note !== undefined ? { note: asked.note } : {}) }
          : { reason: 'unstamped-stop', found: 'unknown' };
        const found = drop.found;
        // What it was told silences this only where it was told after what
        // this reads (the newest ask of the hold, the release, the note): a
        // row older than a later ask never does, so a loss asked again
        // after it was told is told again.
        const evidence = Math.max(asked?.newest ?? -Infinity, ranAfter.at(-1)?.sequence ?? -Infinity, noteAt ?? -Infinity);
        const said = toldBefore(epochId).filter((told) => told.at > evidence);
        if (said.some((told) => FOUND_RANK[told.found] > FOUND_RANK[found] || (told.found === found && told.note === drop.note))) {
          console.error(`[tune-out] the last stop did not record the state of ${what}, which ${author} was told already, with nothing more to say now`);
          continue;
        }
        console.error(`[tune-out] the last stop did not record the state of ${what}, so ${author} is told `
          + (found === 'delivered' ? 'that the note it left with a cancel of it was delivered, and its end not recorded'
            : found === 'ran' ? 'that a cancel of it ran, its release stored and its end not recorded'
            : found === 'asked' ? 'that the cancel of it it asked for, answered as waiting, was lost, with its note'
            : 'that a cancel of it then waiting, if it asked for one, was lost, with any note'));
        try {
          this.hooks.emitTrace({ type: 'tune-out:stop-unrecorded', serverId, channelId, epochId, ...(scope ? { scope } : {}), noteAuthor: author, found });
        } catch (err) {
          console.error(`[tune-out] that the last stop did not record the state of ${what} could not be traced: ${thrownReason(err)}`);
        }
        const notice: LossNotice = {
          id: randomUUID(),
          for: { epochId, serverId, channelId, ...(scope ? { scope } : {}), current: this.epochHoldingAt(serverId, channelId, scope) },
          what, drop, keptAtMs: Date.now(), ...(bootHead !== undefined ? { keptAtSequence: bootHead } : {}), persistent: true,
        };
        this.lossNotices.set(author, [...(this.lossNotices.get(author) ?? []), notice]);
      }
      this.writeLossNotices(author);
      // Kept, not written (writes held, or the subconscious's context
      // refusing them), each is kept in the store at once, held writes or
      // not, as the boot's stamp is: a crash before the writes land then
      // leaves it for the next boot's replay (restoreLossNotices), whose scan
      // reads only the run that crashed. Where the store refuses the record
      // too, it is tried again when writes land (writeLossNotices); a crash
      // before then loses it, which nothing here can help.
      this.writeLossRecord('boot');
      if (this.lossNotices.size > 0) this.armDeferredRetry();
    } catch (err) {
      console.error(`[tune-out] whether the last stop recorded the holds on record could not be checked at boot: ${thrownReason(err)}`);
    }
  }

  /**
   * This run's stamp (noteUnstampedStop), written; one the store refused is
   * kept (`markerPending`) and tried again at each release and by the retry
   * timer, as the loss notices are (runDeferredCancels), never while writes
   * are held but at boot, until it lands or the stop writes its own. Never
   * throws.
   */
  private writePendingMarker(): void {
    const marker = this.markerPending;
    if (!marker) return;
    try {
      this.channelRegistry.writeCoordinatorState(this.stopStampStateId, marker);
      if (this.markerUnwritten) console.error(`[tune-out] this run's stop stamp (${this.stopStampStateId}) is written, at a later try`);
      this.markerPending = undefined;
      this.markerUnwritten = false;
    } catch (err) {
      if (!this.markerUnwritten) {
        console.error(`[tune-out] this run's stop stamp (${this.stopStampStateId}) could not be written, so if the host dies before its next `
          + `stop, the stamp the last stop left may cover the holds it names; it is tried again at the next release or `
          + `${EXPIRY_RETRY_MS / 1000} s later: ${thrownReason(err)}`);
      }
      this.markerUnwritten = true;
    }
  }

  /**
   * For a hold the last stop didn't stamp (noteUnstampedStop): the persistent
   * subconscious's own `cancel_tuneout` of it (`asks`, cancelAsksIn),
   * answered as waiting, since the hold began and since the last run began
   * (`since`). One names the hold where its result says the all-except hold
   * (`scope`, the call naming that scope or a channel only that hold held),
   * for that hold; else, for a channel's, where it names the channel (its
   * id, its shown name, or its server-qualified name) and its server: the
   * result's (`serverId`), the call's, or the qualified name's. A bare name
   * with no server that two holds on record answer to names neither. Answers
   * the first such call's sequence, and the first line, at most
   * NOTE_QUOTE_CHARS characters, of the first such call's note (a cancel
   * waiting with none takes a later call's note; a later note is dropped,
   * and its caller told so). Undefined where none is found.
   */
  private askedCancelOf(hold: HoldOnRecord, since: number | undefined, asks: readonly CancelAsk[], onRecord: readonly HoldOnRecord[]): { sequence: number; newest: number; note?: string } | undefined {
    const after = Math.max(hold.startedAt ?? -Infinity, since ?? -Infinity);
    const namesOf = (h: HoldOnRecord): string[] => {
      let shown: string;
      try {
        shown = this.shown(h.serverId, h.channelId);
      } catch {
        shown = h.channelId;
      }
      return [h.channelId, shown, qualifiedChannelName({ serverId: h.serverId, channelId: h.channelId })];
    };
    const names = (ask: CancelAsk, h: HoldOnRecord): boolean => {
      const toScope = ask.scope === 'all-except' || ask.input.scope === 'all-except';
      if (h.scope === 'all-except') return toScope;
      if (toScope || typeof ask.input.channelId !== 'string') return false;
      const name = ask.input.channelId;
      if (!namesOf(h).includes(name)) return false;
      // The qualified name's server: without it, the bare-name check below
      // reaches the same answer, as no other hold answers to this hold's
      // qualified name; it is kept so the server is read where it is named.
      const server = ask.serverId
        ?? (typeof ask.input.serverId === 'string' && ask.input.serverId ? ask.input.serverId : undefined)
        ?? (name === qualifiedChannelName({ serverId: h.serverId, channelId: h.channelId }) ? h.serverId : undefined);
      if (server !== undefined) return server === h.serverId;
      return !onRecord.some((other) => other !== h && !other.scope && namesOf(other).includes(name));
    };
    const mine = asks.filter((ask) => ask.waiting && ask.sequence > after && names(ask, hold));
    if (mine.length === 0) return undefined;
    const withNote = mine.find((ask) => typeof ask.input.text === 'string' && ask.input.text.trim() !== '');
    const newest = mine.at(-1)!.sequence;
    if (!withNote) return { sequence: mine[0]!.sequence, newest };
    const first = (withNote.input.text as string).trim().split(/\r?\n/)[0]!.trim();
    return { sequence: mine[0]!.sequence, newest, note: first.length > NOTE_QUOTE_CHARS ? `${cutToFit(first, NOTE_QUOTE_CHARS - 1)}…` : first };
  }

  /**
   * At boot (resumeActiveEpochs), before this boot writes any notice: a
   * loss told to the persistent subconscious before the stop, by a notice
   * (`tune-out-note-undelivered`) or in a release (`lostNote`,
   * queuedNoteFirst), asked for a turn to read it, which was kept in memory
   * only. Shown to it at rest, such a row is in its window, so the boot's
   * wake for rows its window is still owed doesn't count it; one with no
   * turn of the subconscious's after it in its window (unansweredIn) gets
   * that turn asked for again, once per hold, for the reason the notice
   * asked it for. Never throws.
   */
  private askTurnsForUnreadLosses(): void {
    try {
      const author = this.hooks.subconsciousName();
      if (!author || !this.hooks.subconsciousWindow) return;
      const unread = unansweredIn(this.hooks.subconsciousWindow(), author, (m) => {
        const meta = m.metadata as { kind?: unknown; lostNote?: unknown } | undefined;
        return meta?.kind === 'tune-out-note-undelivered' || (meta?.kind === 'tune-out-cancel' && meta.lostNote === true);
      });
      const asked = new Set<string>();
      for (const m of unread) {
        const meta = m.metadata as { channelId?: unknown; serverId?: unknown; scope?: unknown; stopUnrecorded?: unknown } | undefined;
        const where = meta?.scope === 'all-except' ? 'all-except'
          : typeof meta?.channelId === 'string' ? this.shown(typeof meta.serverId === 'string' ? meta.serverId : '', meta.channelId) : 'a tune-out';
        const reason = meta?.stopUnrecorded ? `tune-out stop not recorded: ${where}` : `tune-out note not delivered: ${where}`;
        if (asked.has(reason)) continue;
        asked.add(reason);
        this.hooks.requestInference(author, reason, 'tune-out');
      }
      if (asked.size > 0) {
        console.error(`[tune-out] ${author} was told of a lost note before the stop and has had no turn since, so a turn to read it is asked for again (${[...asked].join(', ')})`);
      }
    } catch (err) {
      console.error(`[tune-out] the losses told to the subconscious before the stop could not be checked for a turn at boot: ${thrownReason(err)}`);
    }
  }

  /**
   * At boot (resumeActiveEpochs): the loss notices a stop left kept in the
   * store for the persistent subconscious (writeLossRecord) are written now,
   * as tellNoteLost writes them, each with a turn to read it
   * (writeLossNotice); one written leaves the record, and one whose write
   * fails stays, kept and tried again at the next release and at the retry,
   * which this arms. A notice whose author is no agent the framework writes
   * to now reaches no one, which is traced (`author-gone`), and leaves the
   * record. Never throws.
   */
  private restoreLossNotices(): Set<string> {
    // The holds whose waiting cancel's loss the last stop kept (`stopped`),
    // which accounts for them (noteUnstampedStop).
    const stopKept = new Set<string>();
    try {
      if (!this.readLossRecord() || this.lossNotices.size === 0) return stopKept;
      for (const kept of this.lossNotices.values()) {
        for (const notice of kept) if (notice.persistent && notice.drop.reason === 'stopped') stopKept.add(notice.for.epochId);
      }
      const count = [...this.lossNotices.values()].reduce((n, kept) => n + kept.length, 0);
      console.error(`[tune-out] ${count} loss notice(s) kept in the store for the subconscious before the last stop ${count === 1 ? 'is' : 'are'} tried again now`);
      this.writeLossNotices();
      if (this.lossNotices.size > 0) this.armDeferredRetry();
    } catch (err) {
      console.error(`[tune-out] the loss notices kept in the store for the subconscious could not be written at boot: ${thrownReason(err)}`);
    }
    return stopKept;
  }

  /**
   * One loss notice (LossNotice) written into its author's context: a
   * host-framed notice, as the coordinator's other notices to a reader are,
   * and for the persistent subconscious a turn to read it, as they ask: the
   * loss can come with no turn of its (a release, a retry, a cancel it
   * didn't make), and one asked for with a cancel's own notice is the same
   * turn. A reader fork still alive is in its run, which takes the notice
   * at its next point. Answers what became of it. `failed`: its write
   * threw, or its words couldn't be put together; it is logged, traced at
   * its first failure (`tune-out:note-loss-untold`, `write-failed`), and
   * kept. `gone`: the framework wrote nothing, answering an empty id, as it
   * does for a write for an agent it has no registration of, a reader fork
   * whose run has ended among them: the loss reaches no one, which is
   * logged and traced (`author-gone`). It is written only while writes
   * aren't held (writeLossNotices), so an empty id is no write kept in
   * memory, unless this write began such a hold (a context manager that
   * refuses its work from it on), which writesHeld then says, and which
   * stores the write at its release. A reader fork's own context manager
   * refusing its work isn't told apart from its end here: the framework
   * answers an empty id for both. A turn that can't be asked for is
   * logged. Never throws.
   */
  private writeLossNotice(author: string, notice: LossNotice): 'written' | 'failed' | 'gone' {
    const { serverId, channelId, epochId, scope } = notice.for;
    const { drop } = notice;
    let shown: string;
    let id: string;
    try {
      shown = this.shown(serverId, channelId);
      const hold = scope === 'all-except' ? `the all-except hold (all channels except ${shown})` : shown;
      const resident = this.hooks.primaryName();
      const it = scope ? 'hold' : 'tune-out';
      // Whether the hold is still in force when the notice is written, the
      // next boot's or a later retry's: unknown where that can't be read.
      const nowInForce = (): string => {
        let still: boolean | undefined;
        try {
          still = notice.for.current() === epochId;
        } catch {
          still = undefined;
        }
        return still === true ? ` That ${it} is still in force.` : still === false ? ` That ${it} has ended since.` : '';
      };
      let why = '';
      if (drop.reason === 'hold-ended') {
        why = `That ${it} ended without your cancel while it waited, so your cancel was dropped, and the note with it.`;
        if (drop.current !== undefined) {
          // The later hold as it is when the notice is written, which a
          // kept notice is after the drop: whether it still holds, unknown
          // where that can't be read.
          let still: boolean | undefined;
          try {
            still = notice.for.current() === drop.current;
          } catch {
            still = undefined;
          }
          const later = scope ? 'A later all-except hold' : `A later tune-out of ${shown}`;
          why += still
            ? ` ${later} is in force now, which your cancel was not for.`
            : ` ${later}, which your cancel was not for, was in force when your cancel was dropped`
              + `${still === false ? ', and has ended since' : ''}.`;
        }
      } else if (drop.reason === 'stopped') {
        why = `The host stopped while your cancel waited, so your cancel was lost, and the note with it.${nowInForce()}`;
      } else if (drop.reason === 'unstamped-stop') {
        // Written whole below.
      } else {
        const reason = suppliedValue(drop.error);
        // A thrown error's words may end without a stop.
        why = `${drop.by === 'another' ? `Another cancel ended that ${it} while yours waited` : `Your cancel ended that ${it} when it ran`}, `
          + `and delivering the note then failed: ${reason}${/[.!?]$/.test(reason) ? '' : '.'}`;
      }
      const to = resident ? suppliedValue(resident) : 'the resident';
      let text: string;
      if (drop.reason === 'unstamped-stop') {
        const unrecorded = `[${NOTICE_TAG.tuneOut}: the host stopped without recording the state of `
          + `${scope ? `the all-except hold (all channels except ${shown}; epoch ${epochId})` : `the tune-out of ${shown} (epoch ${epochId})`}. `;
        let still: boolean | undefined;
        try {
          still = notice.for.current() === epochId;
        } catch {
          still = undefined;
        }
        const notRecorded = (whose: string): string => `${whose} was not recorded`
          + (still === true ? `, so that ${it} is still in force.` : still === false ? `, and that ${it} has ended since.` : '.');
        if (drop.found === 'delivered') {
          // The note's row is stored, no release since, the end of its cancel's hold not.
          text = `${unrecorded}The note you left with your cancel of it was delivered to ${to} before the stop. ${notRecorded("The cancel's end")}]`;
        } else if (drop.found === 'ran' && drop.own) {
          // Its own cancel stored the release since it asked, the end not.
          const who = drop.asked ? 'The cancel of it you asked for' : 'Your cancel of it';
          const note = drop.noteDelivered ? ', with the note you left with it'
            : drop.note !== undefined ? `, but the note you left with it, ${quotedValue(drop.note)}, did not` : '';
          text = `${unrecorded}${who} ran: its release reached ${to}${note}. ${notRecorded('Its end')}]`;
        } else if (drop.found === 'ran') {
          // Another's cancel stored the release, the end not: the
          // subconscious's own, asked for, had not run. A note of its found
          // went out with that release (queuedNoteFirst writes it first).
          const by = drop.ranBy !== undefined ? ` that wasn't yours (${suppliedValue(drop.ranBy)})` : '';
          text = `${unrecorded}A cancel of it${by} ran: its release reached ${to}`
            + `${drop.noteDelivered ? ', with the note you left with your cancel of it' : ''}. ${notRecorded('Its end')}`
            + (drop.asked
              ? ` The cancel of it you asked for had not run when the host stopped: it was lost`
                + `${!drop.noteDelivered && drop.note !== undefined ? `, and the note you left with it, ${quotedValue(drop.note)}` : ''}.]`
              : ']');
        } else if (drop.found === 'asked') {
          // Its own call, answered as waiting, read from its window.
          text = `${unrecorded}The cancel of it you asked for ${drop.note !== undefined ? `with your note ${quotedValue(drop.note)}` : 'with no note'} `
            + `had not run when the host stopped: it was lost${drop.note !== undefined ? ', and the note you left with it' : ''}.${nowInForce()}]`;
        } else {
          text = `${unrecorded}If you asked for a cancel of it before the stop, it had not run when the host stopped: it was lost, and any `
            + `note you left with it.${nowInForce()}]`;
        }
      } else {
        text = `[${NOTICE_TAG.tuneOut}: the note you left with your cancel of ${hold} was not delivered to ${to}. ${why}]`;
      }
      id = this.hooks.addMessage(
        'user',
        [{ type: 'text', text }],
        {
          system: true, kind: 'tune-out-note-undelivered', channelId, epochId, ...(scope ? { scope } : {}),
          // What an unrecorded stop's notice told, for a later boot (noteUnstampedStop).
          // When the boot decided it (keptAtSequence), which a later boot
          // reads as when it was told, though it was written later.
          ...(drop.reason === 'unstamped-stop' ? { stopUnrecorded: {
            found: drop.found, ...(drop.note !== undefined ? { note: drop.note } : {}),
            ...(notice.keptAtSequence !== undefined ? { keptAtSequence: notice.keptAtSequence } : {}),
          } } : {}),
        },
        author,
      );
    } catch (err) {
      const error = thrownReason(err);
      console.error(`[tune-out] ${author} could not be told ${lossSubject(notice)}, `
        + `so the notice is kept and tried again at the next release or ${EXPIRY_RETRY_MS / 1000} s later: ${error}`);
      if (!notice.traced) {
        notice.traced = true;
        try {
          this.hooks.emitTrace({
            type: 'tune-out:note-loss-untold', serverId, channelId, epochId, ...(scope ? { scope } : {}),
            noteAuthor: author, reason: 'write-failed', error,
          });
        } catch (traceErr) {
          console.error(`[tune-out] the failure to tell ${author} of its lost note could not be traced: ${thrownReason(traceErr)}`);
        }
      }
      return 'failed';
    }
    if (id === '' && !this.writesHeldNow()) {
      console.error(`[tune-out] ${author} is no agent the framework writes to any more, so the notice ${lossSubject(notice)} reaches no one`);
      try {
        this.hooks.emitTrace({
          type: 'tune-out:note-loss-untold', serverId, channelId, epochId, ...(scope ? { scope } : {}),
          noteAuthor: author, reason: 'author-gone',
        });
      } catch (traceErr) {
        console.error(`[tune-out] that the loss of ${author}'s note reaches no one could not be traced: ${thrownReason(traceErr)}`);
      }
      return 'gone';
    }
    if (notice.traced) {
      console.error(`[tune-out] ${author} is told, at a later try, ${lossSubject(notice)}`);
    }
    let subName: string | null;
    try {
      subName = this.hooks.subconsciousName();
    } catch {
      subName = null;
    }
    if (subName === null || subName !== author) return 'written';
    try {
      const where = scope ? 'all-except' : shown;
      this.hooks.requestInference(author, drop.reason === 'unstamped-stop' ? `tune-out stop not recorded: ${where}` : `tune-out note not delivered: ${where}`, 'tune-out');
    } catch (err) {
      console.error(`[tune-out] ${author} was told ${lossSubject(notice)}, but a turn to read it could not be asked for: ${thrownReason(err)}`);
    }
    return 'written';
  }

  /**
   * The queued cancel of this hold (`epochId`, deferCancel), off the queue:
   * a cancel that ends the hold first leaves it nothing to end, and
   * delivers its note: the persistent subconscious's before its release
   * (queuedNoteFirst), a reader fork's after the end (deliverQueuedNote). One queued for an earlier epoch
   * there is dropped, told (dropDeferred). The retry timer goes with the
   * last one, unless a loss notice waits for it (lossNotices).
   */
  private takeDeferred(key: string, epochId: string): DeferredCancel | undefined {
    const entry = this.deferredCancels.get(key);
    if (!entry) return undefined;
    this.deferredCancels.delete(key);
    if (this.deferredCancels.size === 0 && this.lossNotices.size === 0 && !this.markerPending && this.deferredRetry !== undefined) {
      clearTimeout(this.deferredRetry);
      this.deferredRetry = undefined;
    }
    if (entry.for.epochId === epochId) return entry;
    this.dropDeferred(entry, { reason: 'hold-ended' });
    return undefined;
  }

  /**
   * A reader's note to the resident, verbatim: the persistent subconscious's
   * under its own name, a reader fork's (`author`) as attributed mail under
   * the fork's name and incarnation, never the resident's voice. `metadata`
   * is the subconscious's row's; a fork's mail has it without the server.
   * Answers false where neither is configured to deliver it.
   */
  private deliverReaderNote(
    note: string,
    author: string | undefined,
    metadata: { kind: 'subconscious-note'; epochId: string; channelId?: string; serverId?: string },
  ): boolean {
    const subName = this.hooks.subconsciousName();
    if (subName) {
      this.hooks.addMessage(subName, [{ type: 'text', text: note }], { ...metadata });
      return true;
    }
    if (author && this.hooks.deliverFromReader) {
      const { serverId: _server, ...mail } = metadata;
      this.hooks.deliverFromReader(author, [{ type: 'text', text: note }], mail);
      return true;
    }
    return false;
  }

  /**
   * The note a queued cancel carries, delivered once its hold has ended, as
   * a cancel's release delivers its caller's (deliverReaderNote): by
   * another cancel that ended the hold first (takeDeferred, `by` another),
   * a reader fork's, the subconscious's going out before that cancel's
   * release instead (queuedNoteFirst), or by the queued cancel's own run
   * (`by` itself). One that can't be is told lost, with the reason, on
   * stderr, as a trace and to its author where it still exists
   * (dropDeferred), and the cancel that ended the hold goes on: no caller
   * waits on it to be told. One settled already, delivered or told lost
   * (an earlier end whose release then failed), isn't delivered again.
   * Answers whether it was delivered now.
   */
  private deliverQueuedNote(
    entry: DeferredCancel,
    metadata: { kind: 'subconscious-note'; epochId: string; channelId?: string; serverId?: string },
    by: 'another' | 'itself',
  ): boolean {
    if (entry.note === undefined || entry.noteSettled) return false;
    let delivered: boolean;
    try {
      delivered = this.deliverReaderNote(entry.note, entry.noteAuthor, metadata);
    } catch (err) {
      this.dropDeferred(entry, { reason: 'note-undelivered', by, error: thrownReason(err) });
      return false;
    }
    if (!delivered) {
      this.dropDeferred(entry, {
        reason: 'note-undelivered', by,
        error: 'there is no subconscious here, and no delivery of a reader fork\'s note for its author',
      });
      return false;
    }
    entry.noteSettled = true;
    return true;
  }

  /**
   * Before a cancel writes its release, the note of a cancel of this hold
   * still queued (deferCancel; its own release failed since, say) for the
   * persistent subconscious: delivered now, ahead of the release, where a
   * reader fork's goes out after the end (deliverQueuedNote), so that the
   * release can say so where it can't be (lossInRelease). The loss is then
   * stored with the release and made durable with it, or not at all: the
   * hold doesn't end without the release, which throws, the hold staying in
   * force and the queued cancel waiting on with its note, not lost. A
   * notice to the subconscious and the store's record of it are writes of
   * their own, which can be refused while the release is stored, leaving
   * nothing of the loss after a stop; the subconscious's window holds the
   * residents' rows, the release among them, so no notice is written too.
   * Answers the queued cancel and, where its note couldn't be delivered,
   * why; undefined where there is no such note: none queued, one for
   * another epoch (takeDeferred drops it), one with no note or one settled
   * already, or no subconscious (reader forks read).
   */
  private queuedNoteFirst(
    key: string,
    epochId: string,
    metadata: { kind: 'subconscious-note'; epochId: string; channelId?: string; serverId?: string },
  ): { entry: DeferredCancel; lost?: Extract<DeferredDrop, { reason: 'note-undelivered' }> } | undefined {
    const entry = this.deferredCancels.get(key);
    if (!entry || entry.for.epochId !== epochId || entry.note === undefined || entry.noteSettled) return undefined;
    try {
      if (!this.hooks.subconsciousName()) return undefined;
    } catch {
      return undefined;
    }
    try {
      if (this.deliverReaderNote(entry.note, entry.noteAuthor, metadata)) {
        entry.noteSettled = true;
        return { entry };
      }
      return { entry, lost: { reason: 'note-undelivered', by: 'another', error: 'there is no subconscious here to deliver it' } };
    } catch (err) {
      return { entry, lost: { reason: 'note-undelivered', by: 'another', error: thrownReason(err) } };
    }
  }

  /**
   * The words a cancel's release adds for a queued cancel's note it
   * couldn't deliver (queuedNoteFirst): whose note it was, the hold
   * (`hold`, a `tune-out` or a `hold`), the resident it was for, and why,
   * as a notice to the note's author says them (writeLossNotice). The
   * residents and the subconscious read them there.
   */
  private lossInRelease(entry: DeferredCancel, error: string, hold: string, it: 'tune-out' | 'hold'): string {
    const author = this.noteAuthorOf(entry);
    let resident: string | null;
    try {
      resident = this.hooks.primaryName();
    } catch {
      resident = null;
    }
    const reason = suppliedValue(error);
    return `The note${author !== undefined ? ` ${suppliedValue(author)} left` : ' left'} with an earlier cancel of ${hold} was not `
      + `delivered to ${resident ? suppliedValue(resident) : 'the resident'}. This cancel ended that ${it} while that one waited, `
      + `and delivering the note then failed: ${reason}${/[.!?]$/.test(reason) ? '' : '.'}`;
  }

  /** A turn for the persistent subconscious to read the loss of its note that a release told (queuedNoteFirst), as a notice asks for one (writeLossNotice). */
  private askTurnForLoss(where: string): void {
    let subName: string | null;
    try {
      subName = this.hooks.subconsciousName();
    } catch {
      return;
    }
    if (!subName) return;
    try {
      this.hooks.requestInference(subName, `tune-out note not delivered: ${where}`, 'tune-out');
    } catch (err) {
      console.error(`[tune-out] a release told ${subName} that its note to the resident was not delivered, but a turn to read it could not be asked for: ${thrownReason(err)}`);
    }
  }

  /**
   * Arm the one retry of the deferred cancels and the loss notices not
   * written (lossNotices), unless it is armed; it arms itself again while
   * one still waits.
   */
  private armDeferredRetry(): void {
    if (this.deferredRetry !== undefined) return;
    const timer = setTimeout(() => {
      this.deferredRetry = undefined;
      this.runDeferredCancels();
      // Writes held again at the retry: the cancels and notices wait on,
      // for the next release or this retry.
      if (this.deferredCancels.size > 0 || this.lossNotices.size > 0 || this.markerPending) this.armDeferredRetry();
    }, EXPIRY_RETRY_MS);
    timer.unref?.();
    this.deferredRetry = timer;
  }

  /** Whether a reader (persistent subconscious or reader forks) attends holds. */
  hasReader(): boolean {
    return this.readerAvailable();
  }

  /**
   * End a tune-out: system-framed backlog dump into the resident's window
   * (capped), stored and made durable before the epoch's end is recorded,
   * then the lifecycle notice and one wake for the resident.
   * `subconsciousNote` is the subconscious's own text (from its
   * cancel_tuneout call) — delivered verbatim under its name, never
   * synthesized here. A dump that can't be made durable (commitDeliveries)
   * throws, the tune-out still in force, and a later cancel dumps what no
   * earlier dump of the epoch covered (`released`). While the framework
   * keeps writes in memory (writesHeld: a surgery's hold, a manager refusing
   * its work), nothing is dumped or ended yet: the cancel waits, the
   * tune-out in force, and runs once the writes are stored, or told of
   * where storing one fails (runDeferredCancels). It answers `deferred`
   * then.
   */
  cancel(
    serverId: string,
    channelId: string,
    source: string,
    reason: string,
    subconsciousNote?: string,
    /** `reader: 'forks'`: the reader fork whose note this is. */
    noteAuthor?: string,
    /** The lifecycle state the channel returns to (a tool close ends in 'closed'). */
    nextState: 'open' | 'closed' = 'open',
  ): { ok: true; deferred?: true; noteDropped?: true } | { ok: false; error: string } {
    return this.endTuneOut(serverId, channelId, source, reason, subconsciousNote, noteAuthor, nextState);
  }

  /**
   * cancel's work. `asQueued`: the queued cancel this call runs
   * (runDeferredCancels), whose note (`subconsciousNote`) is delivered as a
   * queued one is (deliverQueuedNote), told lost (dropDeferred) where it
   * can't be, the cancel going on.
   */
  private endTuneOut(
    serverId: string,
    channelId: string,
    source: string,
    reason: string,
    subconsciousNote: string | undefined,
    noteAuthor: string | undefined,
    nextState: 'open' | 'closed',
    asQueued?: DeferredCancel,
    /**
     * Who asked for the cancel, by the name it runs under, which its release
     * records: left out, the note's author, as a direct call's is; `null`,
     * no one named (a queued run of a cancel asked for under no name, whose
     * entry may carry a later caller's note).
     */
    askedBy?: string | null,
  ): { ok: true; deferred?: true; noteDropped?: true } | { ok: false; error: string } {
    const caller = askedBy === undefined ? noteAuthor : askedBy ?? undefined;
    const ending = this.channelRegistry.getTuneOutState(serverId, channelId);
    if (!ending) {
      // Its reader is the resident's tune_out: cancel_tuneout finds the channel first.
      return { ok: false, error: this.notTunedOut(this.quotedShown(serverId, channelId), 'you') };
    }

    if (this.writesHeldNow()) {
      const target: DeferredFor = {
        epochId: ending.params.epochId, serverId, channelId,
        current: () => this.channelRegistry.getTuneOutState(serverId, channelId)?.params.epochId,
      };
      const kept = this.deferCancel(this.key(serverId, channelId), target, `${this.shown(serverId, channelId)} (${reason})`,
        (entry) => { this.endTuneOut(serverId, channelId, source, reason, entry.note, entry.noteAuthor, nextState, entry, caller ?? null); },
        subconsciousNote, noteAuthor);
      return { ok: true, deferred: true, ...(kept === 'note-dropped' ? { noteDropped: true as const } : {}) };
    }

    // Backlog: every message held under this epoch that no earlier dump of
    // it covered (one whose cancel failed before the end was recorded), in
    // store order, which is arrival order: a held message is stored as it
    // arrives (#291). A cancel waits while a surgery's hold keeps writes in
    // memory (writesHeld), so they are stored by now; one that went on during
    // the hold, writesHeld having thrown, lists those the hold keeps after
    // every stored one (residentMessages).
    const epochId = ending.params.epochId;
    const ofEpoch = (m: Pick<StoredMessage, 'metadata'>): boolean =>
      (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId;
    const rows = this.residentMessages();
    const earlier = releaseRecordsOf(rows, epochId);
    const dumpedEarlier = keyedBy(earlier);
    const backlog = rows.filter((m) => ofEpoch(m) && !dumpedEarlier(m));
    // Whole messages: a cap below one shows none, where slice(-0.5) would
    // start at 0 and take them all.
    const cap = Math.floor(ending.params.backlogCap);
    // A line names its author as the resident knows them and marks what a
    // text line can't carry (`[image]`), so the dump says what it leaves out.
    const lineOf = renderHeldLine;
    // The tool the truncation note names (#232 gap 11): the one the resident
    // has, when the host says; main's `fetch_history` where no host says.
    const historyTool = this.hooks.historyTool ? this.hooks.historyTool() : 'fetch_history';
    // The channel as the resident and the subconscious are shown it.
    const name = this.shown(serverId, channelId);
    // A cancel of this hold still queued (asked for while writes were held,
    // its release failing since): the subconscious's note it carries goes
    // out now, ahead of this release, which says so where it can't
    // (queuedNoteFirst); the lines fitted below make room for that.
    const noteMetadata = { kind: 'subconscious-note' as const, channelId, serverId, epochId };
    const first = asQueued ? undefined : this.queuedNoteFirst(this.key(serverId, channelId), epochId, noteMetadata);
    const lost = first?.lost ? this.lossInRelease(first.entry, first.lost.error, name, 'tune-out') : undefined;
    const lifecycle = `[${NOTICE_TAG.tuneOut}: ${name} cancelled — ${reason}, ${ending.wakeCount} wake${ending.wakeCount === 1 ? '' : 's'}]`
      + (lost ? `\n\n${lost}` : '');
    const render = (lines: string[], truncated: number): string => {
      const attrs = [
        `channel=${this.quotedShown(serverId, channelId)}`,
        `messages=${backlog.length}`,
        ...(truncated > 0
          ? [`truncated=${truncated} (oldest; ${historyTool ? `${historyTool} covers the rest` : 'not delivered'})`]
          : []),
      ];
      return `${lifecycle}\n\n<tuned-out-backlog ${attrs.join(' ')}>\n${lines.join('\n')}\n</tuned-out-backlog>`;
    };

    // The dump is one message in the residents' shared slot, so each
    // resident's strategy cuts it as it cuts any message past its per-message
    // cap: context-manager's AutobiographicalStrategy (which connectome-host's
    // FrontdeskStrategy extends) and WindowedPassthroughStrategy count a text
    // block at a token per four characters, rounded up, and keep a message's
    // first cap × 4 characters. Cut there, the dump would lose its newest
    // lines, which would still count as shown. So it holds the newest lines
    // that fit whole in the smallest such room, and those it leaves out, the
    // oldest, count as truncated along with those above backlogCap, so the
    // report is told of them. A newest message too long to fit alone is shown
    // cut to the room left and marked, so the residents still get its head,
    // as they would from a row of its own. When no line fits, whole or cut,
    // the dump shows none; if the room is too small for even that, the
    // residents' strategies cut its frame, the header and tags.
    let shown = cap > 0 ? backlog.slice(-cap) : [];
    let lines = shown.map(lineOf);
    const room = this.hooks.residentMessageChars?.();
    if (room !== undefined && render(lines, backlog.length - shown.length).length > room) {
      // The dump's length with no line, for the count that showing k lines
      // leaves out: truncated= takes that count's digits, and goes at 0. With
      // the newest k lines whole, the dump is that and the lines, with a
      // newline between each two. While a message is left out, each line kept
      // makes it longer, and they don't all fit, so the fit keeps lines from
      // the newest while the next one fits.
      const frameShowing = (k: number): number => render([], backlog.length - k).length;
      let used = 0;
      let kept = 0;
      while (kept < lines.length) {
        const next = used + lines[lines.length - 1 - kept]!.length + (kept > 0 ? 1 : 0);
        if (frameShowing(kept + 1) + next > room) break;
        used = next;
        kept++;
      }
      // What of the newest line's text fits beside the frame and the mark. A
      // cut shows some of it or none: a room under one character, or one
      // that would split a surrogate pair, leaves the head empty.
      const head = cutToFit(lines.at(-1) ?? '', room - frameShowing(1) - CUT_MARK.length);
      if (kept === 0 && head !== '') {
        lines = [head + CUT_MARK];
        shown = shown.slice(-1);
      } else {
        lines = lines.slice(lines.length - kept);
        shown = shown.slice(shown.length - kept);
      }
    }
    const truncated = backlog.length - shown.length;

    // Host-framed system artifacts — never voiced as anyone. The dump records
    // the held rows it covered (`released`), so a cancel tried again after
    // this one failed before the end was recorded, in this process or after
    // a restart, dumps only those no dump covered, and writes none when
    // every one was. There is no dump to write when an earlier one covered
    // them all, but the end is still to be recorded.
    const records = [...earlier];
    if (earlier.length === 0 || backlog.length > 0) {
      const record: ReleaseRecord = { ...keysOf(backlog), total: backlog.length, truncated, report: { ids: [], writeIds: [] } };
      this.hooks.addMessage(
        'user',
        [{ type: 'text', text: render(lines, truncated) }],
        { system: true, kind: 'tune-out-cancel', channelId, epochId, released: record, cancel: { source, reason, ...(caller !== undefined ? { by: caller } : {}) }, ...(lost ? { lostNote: true } : {}) },
      );
      records.push(record);
    } else if (lost) {
      // Every held message is in an earlier release: this one carries the
      // loss alone, and covers none (no `released`). `lostNote` marks a
      // release that tells a queued note's loss, as a boot reads it
      // (noteUnstampedStop).
      this.hooks.addMessage('user', [{ type: 'text', text: lifecycle }], { system: true, kind: 'tune-out-cancel', channelId, epochId, cancel: { source, reason, ...(caller !== undefined ? { by: caller } : {}) }, lostNote: true });
    }
    // Told, in the release written: not delivered or told again, even if
    // the release isn't made durable below and the queued cancel runs later.
    if (first?.lost) first.entry.noteSettled = true;
    // The release is durable before the end is recorded (the registry
    // writes the end to its log at once): a crash or a throw before the end
    // leaves the tune-out in force with its release stored, never ended with
    // none. It is stored, not kept in memory: a cancel made while the
    // framework keeps writes in memory waits until it stores them again
    // (deferCancel).
    if (this.hooks.commitDeliveries?.() === false) {
      throw new Error(`the backlog of ${this.quotedShown(serverId, channelId)} could not be made durable, so its tune-out stays in force`);
    }
    this.channelRegistry.cancelTuneOut(serverId, channelId, nextState, source);
    this.clearTimers(serverId, channelId);
    this.divertedSinceInvocation.delete(this.key(serverId, channelId));
    // The subconscious's own words, under its own name, verbatim; a reader
    // fork's as its attributed mail. With its server: a conversational row
    // whose channel the framework reads (repinChannel), where another
    // server's channel can share the id. A cancel of this hold still queued
    // has nothing left to end: it leaves the queue, and the note it carries
    // goes out first, since it was asked for first, then this caller's: the
    // subconscious's went out before the release (queuedNoteFirst), whose
    // loss the release told, with a turn to read it; a reader fork's goes
    // out now. A queued cancel's own run delivers its note as a queued one
    // (asQueued), told lost where it can't be.
    const subName = this.hooks.subconsciousName();
    const queued = this.takeDeferred(this.key(serverId, channelId), epochId);
    const queuedNote = queued !== undefined
      && (queued === first?.entry ? !first.lost : this.deliverQueuedNote(queued, noteMetadata, 'another'));
    if (first?.lost) {
      this.dropDeferred(first.entry, first.lost, 'release');
      this.askTurnForLoss(name);
    }
    const ownNote = asQueued
      ? this.deliverQueuedNote(asQueued, noteMetadata, 'itself')
      : !!subconsciousNote && this.deliverReaderNote(subconsciousNote, noteAuthor, noteMetadata);
    const primary = this.hooks.primaryName();
    if (primary) {
      this.hooks.requestInference(primary, `tune-out cancelled (${reason})`, 'tune-out');
    }
    // The subconscious gets one cancel turn of its own: the issue's cancel
    // shape is dump + a report from the subconscious, and when the dump left
    // messages out, its summary is what covers them. Every held message is
    // stored (#291), so its view has them all, the newest at its next point.
    // A cancel the subconscious makes itself gets the notice and the turn
    // when some of the epoch's messages are ones it hasn't been shown yet
    // (unseenBySubconscious: those that came in during its own turn, say),
    // since it wrote its note before it could see them, and the notice says
    // how many; and when no note of its went out (its own, or a queued
    // cancel's) and the dump left any message out, since nothing else then
    // covers it. Otherwise its note speaks for what it saw.
    const selfCancel = source === 'subconscious';
    const unseen = subName && selfCancel ? this.unseenBySubconscious(ofEpoch) : 0;
    const truncatedInAll = records.reduce((n, r) => n + r.truncated, 0);
    if (subName && (!selfCancel || unseen > 0 || (!ownNote && !queuedNote && truncatedInAll > 0))) {
      const truncNote = truncationNote(records);
      const unseenNote = unseen > 0
        ? ` ${unseen === 1 ? 'One of its held messages' : `${unseen} of its held messages`} came in after you last looked; your view has ${unseen === 1 ? 'it' : 'them'} now.`
        : '';
      this.hooks.addMessage(
        'user',
        [{ type: 'text', text: `[${NOTICE_TAG.tuneOutCancelled}: ${this.shown(serverId, channelId)} — ${reason}.${truncNote}${unseenNote}]` }],
        { system: true, kind: 'tune-out-cancel-report', channelId },
        subName,
      );
      this.hooks.requestInference(subName, `tune-out cancelled: ${name}`, 'tune-out');
    } else if (!subName && this.forkReader) {
      // Forks are the reader: one last fork for the epoch, handed what no
      // fork has been handed yet, plus the cancel notice; its report follows
      // the dump. On a reader's own cancel, the reader has read what it was
      // handed, so a fork follows only when messages arrived after that.
      const stored = this.hooks.getStoredMessages().filter(ofEpoch);
      const unread = this.unhandedBacklog(this.handOffKey(epochId, serverId, channelId), stored).length;
      if (!selfCancel || unread > 0) {
        const truncNote = truncationNote(records);
        const lateNote = selfCancel
          ? ` ${unread === 1 ? 'This message' : `These ${unread} messages`} arrived after the reader that cancelled was handed its own.`
          : '';
        this.invokeReaderFork(serverId, channelId, epochId, 'cancel', `[${NOTICE_TAG.tuneOutCancelled}: ${name} — ${reason}.${truncNote}${lateNote}]`, stored);
      }
    }
    this.dropHandOffs(epochId);
    this.dropLooks(epochId);
    this.forgetWindowStart(epochId);
    // Where the all-except hold still holds the channel, its own messages
    // there that its reader hasn't looked at are counted again, as the
    // channel's own tune-out's count stood in for theirs.
    this.rebuildTally(serverId, channelId);
    this.hooks.emitTrace({ type: 'tune-out:cancelled', serverId, channelId, epochId, reason, wakeCount: ending.wakeCount });
    return { ok: true };
  }

  /** How many stored messages `keep` keeps the subconscious hasn't been shown (the hook's count), 0 where the host can't say. */
  private unseenBySubconscious(keep: (m: Pick<StoredMessage, 'metadata'>) => boolean): number {
    try {
      return this.hooks.unseenBySubconscious?.(keep) ?? 0;
    } catch (err) {
      console.error('[tune-out] could not count the held messages the subconscious has not been shown, so none is counted:', err);
      return 0;
    }
  }

  // ==========================================================================
  // Ingestion: divert, stamp, classify
  // ==========================================================================

  /**
   * Consulted by the framework for every incoming channel message BEFORE
   * storage. Null = channel not tuned out (proceed normally). Otherwise the
   * caller stamps `metadata.tuneOut = { epochId }`, stores the message
   * without waking the residents, and this coordinator has already handled
   * wake bookkeeping (coalesced subconscious invocation, durable count,
   * suppression ack, possible auto-cancel).
   */
  onIncoming(
    serverId: string,
    channelId: string,
    messageId: string,
    tags: string[] | undefined,
    authorId?: string,
    gatePass = true,
  ): { epochId: string } | null {
    const hold = this.holdFor(serverId, channelId);
    if (!hold) return null;
    this.recordHeld(serverId, channelId, messageId, tags, authorId, gatePass);
    return hold;
  }

  /** The epoch holding this channel, or null. Pure: the admission stage's lookup. */
  holdFor(serverId: string, channelId: string): { epochId: string } | null {
    // Precedence: a per-channel epoch keeps its own hold (cadence, budget,
    // stamp); the all-except scope holds whatever else is not the exception.
    const state = this.channelRegistry.getTuneOutState(serverId, channelId);
    if (state) return { epochId: state.params.epochId };
    const scope = this.getAllExcept();
    if (scope && !(scope.params.except.serverId === serverId && scope.params.except.channelId === channelId)) {
      return { epochId: scope.params.epochId };
    }
    return null;
  }

  /** The channel unprefixed speech lands in while an all-except hold is active, with its server, else null. */
  focusChannel(): ChannelRef | null {
    const except = this.getAllExcept()?.params.except;
    return except ? { serverId: except.serverId, channelId: except.channelId } : null;
  }

  // ==========================================================================
  // All-except scope
  // ==========================================================================

  private get scopeStateId(): string {
    return `tune-out/${this.hooks.primaryName() ?? 'default'}/all-except`;
  }

  /**
   * End every hold on record and deliver each backlog to the resident: the
   * per-channel holds, then the all-except scope. For a host with no reader
   * (AgentFramework.releaseTuneOutsWithoutReader) and a reader that ended; a
   * hold whose end fails stays on record, and says so in the log. A
   * per-channel hold ends under its own source, so an agent's tune-out keeps
   * the agent's provenance (the housekeeping guard reads it); `source` is the
   * all-except scope's.
   */
  releaseAll(source: string, reason: string, options: { retry?: boolean; attempt?: number } = {}): void {
    if (this.releaseRetry) {
      clearTimeout(this.releaseRetry);
      this.releaseRetry = null;
    }
    let failed = false;
    // What the registry has on record, registered or not: at a start the
    // channels aren't registered yet, so listActive() would find none.
    let onRecord: ReturnType<ChannelRegistry['tuneOutsOnRecord']> = [];
    try {
      onRecord = this.channelRegistry.tuneOutsOnRecord();
    } catch (err) {
      console.error(`[tune-out] the tune-outs on record could not be read to release them (${reason}), so they stay on record:`, err);
      failed = true;
    }
    for (const { serverId, channelId, source: recorded } of onRecord) {
      try {
        const r = this.cancel(serverId, channelId, recorded, reason);
        if (!r.ok) {
          console.error(`[tune-out] ${this.shown(serverId, channelId)} could not be released (${reason}), so it stays on record: ${r.error}`);
          failed = true;
        }
      } catch (err) {
        console.error(`[tune-out] ${this.shown(serverId, channelId)} could not be released (${reason}), so it stays on record:`, err);
        failed = true;
      }
    }
    try {
      if (this.getAllExcept()) {
        const r = this.cancelAllExcept(source, reason);
        if (!r.ok) {
          console.error(`[tune-out] the all-except hold could not be released (${reason}), so it stays on record: ${r.error}`);
          failed = true;
        }
      }
    } catch (err) {
      console.error(`[tune-out] the all-except hold could not be released (${reason}), so it stays on record:`, err);
      failed = true;
    }
    // With a reader gone mid-run the hold still diverts traffic, and an
    // open-ended one has no end time to release it: try again, backing off,
    // a few times (a try that fails after its dump is durable writes a new
    // one only for messages held since). After the last, the hold stays
    // until the resident cancels it, or the next start releases it (with no
    // reader configured) or resumes it (with one).
    const attempt = options.attempt ?? 1;
    if (failed && options.retry && !this.stopped) {
      if (attempt >= RELEASE_RETRY_ATTEMPTS) {
        console.error(`[tune-out] releasing the holds (${reason}) failed ${attempt} times, so what failed stays held until it is cancelled, or the next start releases it (with no reader configured) or resumes it (with one)`);
      } else {
        this.releaseRetry = setTimeout(() => {
          this.releaseRetry = null;
          this.releaseAll(source, reason, { ...options, attempt: attempt + 1 });
        }, EXPIRY_RETRY_MS * 2 ** (attempt - 1));
      }
    }
  }

  getAllExcept(): AllExceptState | null {
    if (this.scopeCache !== undefined) return this.scopeCache;
    // A record that can't be read, or isn't a hold's, is not taken for no
    // hold: the error goes to the caller and nothing is cached, so the next
    // read tries again. At create() that refuses the start, as an
    // unreadable registry does.
    const raw = this.channelRegistry.readCoordinatorState(this.scopeStateId) as AllExceptState | null;
    if (raw !== null && raw !== undefined && !(typeof raw === 'object' && raw.params && typeof raw.params.epochId === 'string')) {
      throw new Error(`the all-except hold's stored record (${this.scopeStateId}) is not a hold's record; it was left as it is`);
    }
    this.scopeCache = raw ?? null;
    return this.scopeCache;
  }

  private writeScope(state: AllExceptState | null): void {
    // Durable first: a write that fails leaves memory as the store has it.
    this.channelRegistry.writeCoordinatorState(this.scopeStateId, state);
    this.scopeCache = state;
  }

  enterAllExcept(
    except: { serverId: string; channelId: string },
    opts: { cadenceSeconds?: unknown; backlogCap?: unknown; maxWakes?: unknown; durationSeconds?: unknown },
    source: string,
  ): { ok: true; params: AllExceptParams } | { ok: false; error: string } {
    if (!this.readerAvailable()) return { ok: false, error: NO_READER_REFUSAL };
    const read = this.readOptions(opts, {
      durationSeconds: null,
      cadenceSeconds: `for the default, ${TUNE_OUT_DEFAULTS.cadenceSeconds}`,
      backlogCap: `for the default, ${TUNE_OUT_DEFAULTS.backlogCap}`,
      maxWakes: `for the default, ${TUNE_OUT_DEFAULTS.maxWakes}`,
    });
    if (!read.ok) return read;
    const { given, expiresAtMs } = read;
    if (expiresAtMs === undefined) {
      return { ok: false, error: 'an all-except hold needs `durationSeconds`: it always ends on its own' };
    }
    if (this.getAllExcept()) {
      return { ok: false, error: 'an all-except hold is already active (cancel it first)' };
    }
    if (this.channelRegistry.getTuneOutState(except.serverId, except.channelId)) {
      return { ok: false, error: `channel ${except.channelId} is tuned out; it cannot be the exception` };
    }
    if (this.hooks.isForkBound(except)) {
      return { ok: false, error: `channel ${except.channelId} is bound to a conversation fork` };
    }
    const params: AllExceptParams = {
      epochId: randomUUID(),
      except,
      cadenceSeconds: Math.max(30, given.cadenceSeconds ?? TUNE_OUT_DEFAULTS.cadenceSeconds),
      // Whole messages, as a channel's cap is counted: a cap below one shows
      // none, where slice(-0.5) would take them all.
      backlogCap: Math.max(0, Math.floor(given.backlogCap ?? TUNE_OUT_DEFAULTS.backlogCap)),
      maxWakes: Math.max(1, given.maxWakes ?? TUNE_OUT_DEFAULTS.maxWakes),
      startedAtSequence: this.hooks.currentSequence(),
      startedAtMs: read.now,
      expiresAtMs,
      source,
    };
    this.writeScope({ params, wakeCount: 0 });
    this.anchorSubconscious();
    this.armScopeTimers(params);
    this.hooks.emitTrace({
      type: 'tune-out:entered', serverId: except.serverId, channelId: except.channelId, epochId: params.epochId,
      scope: 'all-except', reader: this.readerAvailable(), expiresAtMs: params.expiresAtMs,
    });
    const minutes = Math.max(1, Math.round((params.expiresAtMs - params.startedAtMs) / 60_000));
    const until = new Date(params.expiresAtMs).toISOString().slice(11, 16);
    this.announce(except, params.epochId, 'entered',
      `[${NOTICE_TAG.focus}: ${this.hooks.primaryName() ?? 'the resident'} is here for ${minutes} min, until ${until} UTC; other channels are held meanwhile.]`);
    return { ok: true, params };
  }

  /** Whether entry and release of the all-except scope are announced in the excepted channel. */
  announces(): boolean {
    return typeof this.hooks.announce === 'function';
  }

  /**
   * The excepted channel hears the scope open and close: one bracketed line
   * under the resident's name, posted through the same path as a publish.
   * Fire-and-forget; the outcome is traced, never awaited by the epoch flip.
   */
  private announce(
    target: { serverId: string; channelId: string },
    epochId: string,
    kind: 'entered' | 'released',
    text: string,
  ): void {
    if (!this.hooks.announce) return;
    const base = { serverId: target.serverId, channelId: target.channelId, epochId, kind };
    this.hooks.announce(target.serverId, target.channelId, text).then(
      (r) => this.hooks.emitTrace(r.success
        ? { type: 'tune-out:announced', ...base }
        : { type: 'tune-out:announce-failed', ...base, error: r.error ?? 'publish failed' }),
      (err: unknown) => this.hooks.emitTrace({ type: 'tune-out:announce-failed', ...base, error: (err as Error).message }),
    );
  }

  /** The scope's end time and cadence, on timers no longer than one holds
   *  (deadline-timer), as a channel's tune-out arms its own. */
  private armScopeTimers(params: AllExceptParams): void {
    const key = TuneOutCoordinator.SCOPE_KEY;
    const expiry = this.expiryTimers.get(key);
    if (expiry) clearTimeout(expiry);
    // As a channel's timers: the next turn is armed before this one's work,
    // and a throw is reported (timerFailed) rather than left to end the host.
    const { serverId: exceptServer, channelId: exceptChannel } = params.except;
    const holdExpiry = (timer: ReturnType<typeof setTimeout>): void => { this.expiryTimers.set(key, timer); };
    const end = (): void => {
      try {
        holdExpiry(setTimeout(end, EXPIRY_RETRY_MS));
        if (!this.cancelAllExcept('duration', 'duration elapsed').ok) this.clearScopeTimers();
      } catch (err) {
        this.timerFailed('expiry', exceptServer, exceptChannel, err);
      }
    };
    armAt(params.expiresAtMs, holdExpiry, end);
    if (!this.readerAvailable()) return;
    const cadence = this.cadenceTimers.get(key);
    if (cadence) clearTimeout(cadence);
    const hold = (timer: ReturnType<typeof setTimeout>): void => { this.cadenceTimers.set(key, timer); };
    const tick = () => {
      try {
        const scope = this.getAllExcept();
        if (!scope) return;
        armAfter(params.cadenceSeconds * 1000, hold, tick);
        // One look per held channel with new traffic since the last look.
        for (const [channelKey, diverted] of this.divertedSinceInvocation) {
          if (diverted <= 0) continue;
          const [serverId, channelId] = channelKey.split('\0') as [string, string];
          if (this.channelRegistry.getTuneOutState(serverId, channelId)) continue; // a per-channel epoch's own cadence
          this.invokeSubconscious(serverId, channelId, 'cadence', diverted);
        }
      } catch (err) {
        this.timerFailed('cadence', exceptServer, exceptChannel, err);
      }
    };
    armAfter(params.cadenceSeconds * 1000, hold, tick);
  }

  private clearScopeTimers(): void {
    const key = TuneOutCoordinator.SCOPE_KEY;
    const cadence = this.cadenceTimers.get(key);
    if (cadence) clearTimeout(cadence);
    this.cadenceTimers.delete(key);
    const expiry = this.expiryTimers.get(key);
    if (expiry) clearTimeout(expiry);
    this.expiryTimers.delete(key);
  }

  /** Channels held by the scope (not by their own epoch) with the count held under it. */
  private scopeHeldCounts(epochId: string): Map<string, { serverId: string; channelId: string; count: number }> {
    const counts = new Map<string, { serverId: string; channelId: string; count: number }>();
    for (const m of this.residentMessages()) {
      const meta = m.metadata as { tuneOut?: { epochId?: string }; channelId?: string; serverId?: string } | undefined;
      if (meta?.tuneOut?.epochId !== epochId) continue;
      const channelId = typeof meta.channelId === 'string' ? meta.channelId : '(unknown channel)';
      const serverId = typeof meta.serverId === 'string' ? meta.serverId : '';
      const k = this.key(serverId, channelId);
      const entry = counts.get(k) ?? { serverId, channelId, count: 0 };
      entry.count += 1;
      counts.set(k, entry);
    }
    return counts;
  }

  /**
   * End the all-except hold: one release notice with a per-channel backlog
   * (each capped), stored and made durable before the hold's end is
   * recorded, as a channel's cancel does, then the reader's note if any,
   * one wake for the resident, and the reader's own look at what it had not
   * seen. While the framework keeps writes in memory it waits, as cancel
   * does.
   */
  cancelAllExcept(
    source: string,
    reason: string,
    note?: string,
    noteAuthor?: string,
  ): { ok: true; deferred?: true; noteDropped?: true } | { ok: false; error: string } {
    return this.endAllExcept(source, reason, note, noteAuthor);
  }

  /** cancelAllExcept's work; `asQueued` as endTuneOut's. */
  private endAllExcept(
    source: string,
    reason: string,
    note: string | undefined,
    noteAuthor: string | undefined,
    asQueued?: DeferredCancel,
    /** Who asked for the cancel, as endTuneOut's. */
    askedBy?: string | null,
  ): { ok: true; deferred?: true; noteDropped?: true } | { ok: false; error: string } {
    const caller = askedBy === undefined ? noteAuthor : askedBy ?? undefined;
    const scope = this.getAllExcept();
    if (!scope) return { ok: false, error: 'no all-except hold is active' };
    // As a channel's cancel: while writes are kept in memory, the release
    // would be, and writeScope(null) below is on disk at once.
    if (this.writesHeldNow()) {
      const target: DeferredFor = {
        epochId: scope.params.epochId, serverId: scope.params.except.serverId, channelId: scope.params.except.channelId,
        scope: 'all-except', current: () => this.getAllExcept()?.params.epochId,
      };
      const kept = this.deferCancel(TuneOutCoordinator.SCOPE_KEY, target, `the all-except hold (${reason})`,
        (entry) => { this.endAllExcept(source, reason, entry.note, entry.noteAuthor, entry, caller ?? null); },
        note, noteAuthor);
      return { ok: true, deferred: true, ...(kept === 'note-dropped' ? { noteDropped: true as const } : {}) };
    }
    const { epochId, except, backlogCap } = scope.params;

    const ofEpoch = (m: Pick<StoredMessage, 'metadata'>): boolean =>
      (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId;
    // Stored, and kept by a surgery's hold until its release
    // (residentMessages), less what an earlier release of the hold covered
    // (`released`), as a channel's cancel reads them.
    const rows = this.residentMessages();
    const all = rows.filter(ofEpoch);
    const earlier = releaseRecordsOf(rows, epochId);
    const releasedEarlier = keyedBy(earlier);
    const fresh = all.filter((m) => !releasedEarlier(m));
    const byChannel = new Map<string, { serverId: string; channelId: string; backlog: HeldRow[] }>();
    for (const m of fresh) {
      const meta = m.metadata as { channelId?: string; serverId?: string } | undefined;
      const serverId = meta?.serverId ?? '';
      const channelId = meta?.channelId ?? '(unknown channel)';
      const k = this.key(serverId, channelId);
      const entry = byChannel.get(k) ?? { serverId, channelId, backlog: [] };
      entry.backlog.push(m);
      byChannel.set(k, entry);
    }
    const historyTool = this.hooks.historyTool?.() ?? null;
    let truncatedInAll = 0;
    const dumps = [...byChannel.values()].map(({ serverId, channelId, backlog }) => {
      // Floored here too: a hold stored before entry floored its cap can hold
      // a fraction.
      const cap = Math.floor(backlogCap);
      const shown = cap > 0 ? backlog.slice(-cap) : [];
      const truncated = backlog.length - shown.length;
      truncatedInAll += truncated;
      const attrs = [
        `channel=${quotedValue(this.shown(serverId, channelId))}`,
        `messages=${backlog.length}`,
        ...(truncated > 0 ? [`truncated=${truncated} (oldest; ${historyTool ? `${historyTool} covers the rest` : 'not delivered'})`] : []),
      ];
      return `<tuned-out-backlog ${attrs.join(' ')}>\n${shown.map(renderHeldLine).join('\n')}\n</tuned-out-backlog>`;
    });
    const summary = byChannel.size === 0
      ? 'Nothing was held.'
      : `${fresh.length} message${fresh.length === 1 ? '' : 's'} held in ${byChannel.size} channel${byChannel.size === 1 ? '' : 's'}.`;
    // A cancel of this hold still queued: the subconscious's note goes out
    // now, ahead of this release, which says so where it can't, as a
    // channel's cancel does (queuedNoteFirst).
    const shownExcept = this.shown(except.serverId, except.channelId);
    const first = asQueued ? undefined : this.queuedNoteFirst(TuneOutCoordinator.SCOPE_KEY, epochId, { kind: 'subconscious-note', epochId });
    const lost = first?.lost
      ? this.lossInRelease(first.entry, first.lost.error, `the all-except hold (all channels except ${shownExcept})`, 'hold')
      : undefined;
    const header = `[${NOTICE_TAG.tuneOut}: all channels except ${shownExcept} released — ${reason}, ${scope.wakeCount} wake${scope.wakeCount === 1 ? '' : 's'}]`
      + (lost ? `\n\n${lost}` : '');
    if (earlier.length === 0 || fresh.length > 0) {
      const record: ReleaseRecord = { ...keysOf(fresh), total: fresh.length, truncated: truncatedInAll, report: { ids: [], writeIds: [] } };
      this.hooks.addMessage(
        'user',
        [{ type: 'text', text: `${header}\n\n${summary}${dumps.length > 0 ? '\n\n' + dumps.join('\n\n') : ''}` }],
        { system: true, kind: 'tune-out-cancel', scope: 'all-except', channelId: except.channelId, epochId, released: record, cancel: { source, reason, ...(caller !== undefined ? { by: caller } : {}) }, ...(lost ? { lostNote: true } : {}) },
      );
    } else if (lost) {
      this.hooks.addMessage('user', [{ type: 'text', text: header }],
        { system: true, kind: 'tune-out-cancel', scope: 'all-except', channelId: except.channelId, epochId, cancel: { source, reason, ...(caller !== undefined ? { by: caller } : {}) }, lostNote: true });
    }
    if (first?.lost) first.entry.noteSettled = true;
    if (this.hooks.commitDeliveries?.() === false) {
      throw new Error('the all-except release could not be made durable, so the hold stays in force');
    }
    this.writeScope(null);
    this.clearScopeTimers();
    for (const [key, pending] of this.pendingWakes) {
      const [serverId, channelId] = key.split('\0') as [string, string];
      if (this.channelRegistry.getTuneOutState(serverId, channelId)) continue;
      clearTimeout(pending.timer);
      this.pendingWakes.delete(key);
    }
    // A cancel of this hold still queued has nothing left to end, and its
    // note goes out first, as a channel's cancel delivers one: the
    // subconscious's went out before the release (queuedNoteFirst, settled
    // then), a reader fork's goes out now; so does a queued cancel's own run
    // deliver its note (asQueued).
    const subName = this.hooks.subconsciousName();
    const queued = this.takeDeferred(TuneOutCoordinator.SCOPE_KEY, epochId);
    if (queued) this.deliverQueuedNote(queued, { kind: 'subconscious-note', epochId }, 'another');
    if (first?.lost) {
      this.dropDeferred(first.entry, first.lost, 'release');
      this.askTurnForLoss('all-except');
    }
    if (asQueued) this.deliverQueuedNote(asQueued, { kind: 'subconscious-note', epochId }, 'itself');
    else if (note) this.deliverReaderNote(note, noteAuthor, { kind: 'subconscious-note', epochId });
    const primary = this.hooks.primaryName();
    if (primary) this.hooks.requestInference(primary, `tune-out cancelled (${reason})`, 'tune-out');
    const notice = `[${NOTICE_TAG.tuneOutCancelled}: all channels except ${this.shown(except.serverId, except.channelId)} — ${reason}.]`;
    if (source !== 'subconscious' && subName) {
      this.hooks.addMessage('user', [{ type: 'text', text: notice }], { system: true, kind: 'tune-out-cancel-report', scope: 'all-except' }, subName);
      this.hooks.requestInference(subName, 'tune-out cancelled: all-except', 'tune-out');
    } else if (!subName && this.forkReader) {
      // One last look per channel with messages no fork was handed. That
      // holds for a reader's own release too: the reader that released read one channel's
      // messages, and every other channel's would otherwise reach no reader.
      // A channel is its server and id here, as the readers' bookkeeping is.
      const channels = new Map<string, ChannelRef>();
      for (const m of all) {
        const meta = m.metadata as { channelId?: string; serverId?: string } | undefined;
        const ref = { serverId: meta?.serverId ?? '', channelId: meta?.channelId ?? '(unknown channel)' };
        channels.set(this.key(ref.serverId, ref.channelId), ref);
      }
      for (const { serverId, channelId } of channels.values()) {
        const ofChannel = inChannelOf(serverId, channelId);
        const inChannel = (m: Pick<StoredMessage, 'metadata'>): boolean => ofEpoch(m) && ofChannel(m);
        const stored = this.hooks.getStoredMessages().filter(inChannel);
        if (this.unhandedBacklog(this.handOffKey(epochId, serverId, channelId), stored).length > 0) {
          this.invokeReaderFork(serverId, channelId, epochId, 'cancel', notice, stored);
        }
      }
    }
    for (const key of this.divertedSinceInvocation.keys()) {
      const [serverId, channelId] = key.split('\0') as [string, string];
      if (!this.channelRegistry.getTuneOutState(serverId, channelId)) this.divertedSinceInvocation.delete(key);
    }
    this.dropHandOffs(epochId);
    this.dropLooks(epochId);
    this.forgetWindowStart(epochId);
    this.hooks.emitTrace({ type: 'tune-out:cancelled', serverId: except.serverId, channelId: except.channelId, epochId, scope: 'all-except', reason, wakeCount: scope.wakeCount });
    // The line the excepted channel sees names no agent but the resident:
    // a reader's cancel is "by its reader" there, its name kept for the
    // resident's line, the reader's notice and the trace above.
    const channelReason = source === 'subconscious' ? 'by its reader' : reason;
    this.announce(except, epochId, 'released', `[${NOTICE_TAG.focus}: ${primary ?? 'the resident'} released — ${channelReason}.]`);
    return { ok: true };
  }

  /** What is held right now — per-channel epochs and the scope — without releasing. */
  check(opts: { peek?: { serverId?: string; channelId: string }; peekLimit?: number } = {}): TuneOutCheck {
    // Stored, and kept by a surgery's hold until its release (residentMessages).
    const stored = this.residentMessages();
    const countOf = (epochId: string) => stored.filter(
      (m) => (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId,
    ).length;
    const channels = this.listActive().map(({ serverId, channelId, params }) => ({
      serverId, channelId, epochId: params.epochId, held: countOf(params.epochId),
      ...(params.expiresAtMs !== undefined ? { expiresAtMs: params.expiresAtMs } : {}),
    }));
    const scope = this.getAllExcept();
    let allExcept: TuneOutCheck['allExcept'] = null;
    if (scope) {
      const held: Record<string, number> = {};
      for (const { serverId, channelId, count } of this.scopeHeldCounts(scope.params.epochId).values()) held[this.shown(serverId, channelId)] = count;
      allExcept = { epochId: scope.params.epochId, except: scope.params.except, expiresAtMs: scope.params.expiresAtMs, wakeCount: scope.wakeCount, held };
    }
    const result: TuneOutCheck = { allExcept, channels };
    if (opts.peek) {
      const limit = Math.max(1, Math.min(50, opts.peekLimit ?? 5));
      // Only what is held NOW: the channel's own epoch, or the scope's. A
      // released epoch's messages are delivered, not held; showing them here
      // would be a false declaration (first live run, 2026-10-12, finding B).
      const active = new Set<string>();
      for (const e of channels) {
        if (e.channelId === opts.peek.channelId && (!opts.peek.serverId || e.serverId === opts.peek.serverId)) active.add(e.epochId);
      }
      if (scope) active.add(scope.params.epochId);
      const lines = stored
        .filter((m) => {
          const meta = m.metadata as { tuneOut?: { epochId?: string }; channelId?: string; serverId?: string } | undefined;
          return typeof meta?.tuneOut?.epochId === 'string' && active.has(meta.tuneOut.epochId)
            && meta.channelId === opts.peek!.channelId
            && (!opts.peek!.serverId || meta.serverId === opts.peek!.serverId);
        })
        .slice(-limit)
        .map(renderHeldLine);
      result.peek = lines;
    }
    return result;
  }

  /**
   * Bookkeeping for one held message, after admission decided the hold:
   * the cadence tally, the deterministic acknowledgement of a suppressed
   * mention, and the reader wake when the resident's gate would have woken
   * them (`gatePass` is that verdict, probed without side effects).
   */
  recordHeld(
    serverId: string,
    channelId: string,
    messageId: string,
    tags: string[] | undefined,
    authorId?: string,
    gatePass = true,
  ): void {
    const key = this.key(serverId, channelId);
    this.divertedSinceInvocation.set(key, (this.divertedSinceInvocation.get(key) ?? 0) + 1);

    // Wake classification: the resident's wake gate composes as a
    // PRECONDITION (antra, #tuneout-talk: the subconscious is affected BY
    // main's wake gate, it does not replace it) — an event the gate would
    // suppress for the resident (muted author, rate-limit) must not wake
    // the subconscious either; it diverts silently into the backlog and
    // surfaces in cadence summaries. On top of the gate: addressed
    // mentions and gate-privileged authors wake, per the issue.
    const addressed = Array.isArray(tags) && tags.includes('chat:addressed');
    const privileged = this.hooks.isPrivilegedAuthor(authorId);
    if (gatePass && addressed) {
      // The mention-er always gets a deterministic signal, independent of
      // what the subconscious later decides (grant-gated; decline
      // precedent). Gate-suppressed mentions get NO reaction: main would
      // not have signaled either, and reacting would leak the resident's
      // standing mute to its subject.
      void this.acknowledgeSuppressed(serverId, channelId, messageId);
    }
    if (gatePass && (addressed || privileged) && this.readerAvailable()) {
      this.scheduleWakeInvocation(serverId, channelId);
    }
  }

  /** Reader forks that reported through `deliver_summary` (so their trailing prose is not a second report). */
  private readerReports = new Set<string>();

  readerReported(reader: string): boolean {
    return this.readerReports.has(reader);
  }

  forgetReader(reader: string): void {
    this.readerReports.delete(reader);
  }

  private async acknowledgeSuppressed(serverId: string, channelId: string, messageId: string): Promise<void> {
    try {
      const server = this.serverRegistry.getServer(serverId);
      if (!server || !CapabilityGrant.of(server).has('channels.acknowledge')) return;
      await server.sendChannelsAcknowledge({
        channelId,
        messageId,
        intent: 'suppressed-tuned-out',
      });
    } catch (err) {
      console.error(`[tune-out] acknowledging ${messageId} in ${channelId} on ${serverId} failed:`, err);
      this.hooks.emitTrace({
        type: 'tune-out:ack-failed',
        serverId,
        channelId,
        error: thrownReason(err),
      });
    }
  }

  // ==========================================================================
  // Subconscious invocation (cadence + coalesced wakes)
  // ==========================================================================

  private startCadence(serverId: string, channelId: string, cadenceSeconds: number): void {
    this.stopCadence(serverId, channelId);
    const key = this.key(serverId, channelId);
    const hold = (timer: ReturnType<typeof setTimeout>): void => { this.cadenceTimers.set(key, timer); };
    const tick = () => {
      try {
        const state = this.channelRegistry.getTuneOutState(serverId, channelId);
        if (!state) return; // cancelled meanwhile
        // The next period is armed before this one's turn, so a turn that
        // fails can't end the cadence.
        armAfter(cadenceSeconds * 1000, hold, tick);
        const diverted = this.divertedSinceInvocation.get(key) ?? 0;
        // An empty period needs no turn at all — skip silently.
        if (diverted > 0) {
          this.invokeSubconscious(serverId, channelId, 'cadence', diverted);
        }
      } catch (err) {
        this.timerFailed('cadence', serverId, channelId, err);
      }
    };
    armAfter(cadenceSeconds * 1000, hold, tick);
  }

  /** Clear a channel's tune-out timers: its cadence, its end time and a wake
   *  still coalescing. */
  private clearTimers(serverId: string, channelId: string): void {
    const key = this.key(serverId, channelId);
    this.stopCadence(serverId, channelId);
    const expiry = this.expiryTimers.get(key);
    if (expiry) clearTimeout(expiry);
    this.expiryTimers.delete(key);
    const pending = this.pendingWakes.get(key);
    if (pending) clearTimeout(pending.timer);
    this.pendingWakes.delete(key);
  }

  private stopCadence(serverId: string, channelId: string): void {
    const key = this.key(serverId, channelId);
    const timer = this.cadenceTimers.get(key);
    if (timer) clearTimeout(timer);
    this.cadenceTimers.delete(key);
  }

  private scheduleWakeInvocation(serverId: string, channelId: string): void {
    const key = this.key(serverId, channelId);
    const pending = this.pendingWakes.get(key);
    if (pending) {
      pending.count++;
      return;
    }
    const timer = setTimeout(() => {
      try {
        const entry = this.pendingWakes.get(key);
        this.pendingWakes.delete(key);
        this.fireWake(serverId, channelId, entry?.count ?? 1);
      } catch (err) {
        this.timerFailed('wake', serverId, channelId, err);
      }
    }, WAKE_COALESCE_MS);
    this.pendingWakes.set(key, { count: 1, timer });
  }

  private cancelPastBudget(serverId: string, channelId: string, maxWakes: number, from: 'wake' | 'start' = 'wake'): void {
    const key = this.key(serverId, channelId);
    const existing = this.expiryTimers.get(key);
    if (existing) clearTimeout(existing);
    const end = (first: boolean): void => {
      try {
        this.expiryTimers.set(key, setTimeout(() => end(false), EXPIRY_RETRY_MS));
        if (!this.cancel(serverId, channelId, 'tune-out-max-wakes', `wake budget exhausted (${maxWakes})`).ok) {
          this.clearTimers(serverId, channelId);
        }
      } catch (err) {
        if (first && from === 'start') {
          if (this.channelRegistry.getTuneOutState(serverId, channelId)) {
            console.error(`[tune-out] ${this.shown(serverId, channelId)} was past its wake budget at start, and its cancel failed, so it stays tuned out and its cancel is tried again in ${EXPIRY_RETRY_MS / 1000} s:`, err);
          } else {
            console.error(`[tune-out] ${this.shown(serverId, channelId)} was past its wake budget at start and its cancel ended it, but a step after the end failed:`, err);
          }
        } else {
          this.timerFailed('wake', serverId, channelId, err);
        }
      }
    };
    end(true);
  }

  /** One coalesced wake: counted durably against the epoch that holds the channel. */
  private fireWake(serverId: string, channelId: string, count: number): void {
    if (this.channelRegistry.getTuneOutState(serverId, channelId)) {
      // Count ONE durable wake per coalesced invocation.
      const counted = this.channelRegistry.recordTuneOutWake(serverId, channelId);
      if (!counted) return; // cancelled inside the window
      if (counted.wakeCount > counted.params.maxWakes) {
        this.cancelPastBudget(serverId, channelId, counted.params.maxWakes);
        return;
      }
      this.invokeSubconscious(serverId, channelId, 'wake', count);
      return;
    }
    const scope = this.getAllExcept();
    if (!scope) return; // released inside the window
    // The all-except scope: exhausting the budget pauses the reader, it does
    // not end the hold (#232 §3.2 — the hold is the resident's bounded
    // commitment; the deadline ends it).
    const wakeCount = scope.wakeCount + 1;
    this.writeScope({ ...scope, wakeCount });
    if (wakeCount > scope.params.maxWakes) {
      this.hooks.emitTrace({
        type: 'tune-out:wake-budget-paused', epochId: scope.params.epochId, scope: 'all-except',
        serverId, channelId, wakeCount, maxWakes: scope.params.maxWakes,
      });
      return;
    }
    this.invokeSubconscious(serverId, channelId, 'wake', count);
  }

  /**
   * One subconscious turn: a system-framed trigger notice (bracket style —
   * what happened, never what to say) plus standing dispositions, then an
   * inference request. Its view supplies the actual traffic: the merged
   * record while its window is the record, and with the presentation index
   * (#291) what its window holds, which takes what it hasn't been shown at
   * the turn's start, the notice included.
   */
  private invokeSubconscious(
    serverId: string,
    channelId: string,
    trigger: 'cadence' | 'wake',
    count: number,
  ): void {
    const subName = this.hooks.subconsciousName();
    if (!subName && !this.forkReader) return;
    const key = this.key(serverId, channelId);

    const shown = this.shown(serverId, channelId);
    const notice = trigger === 'wake'
      ? `[${NOTICE_TAG.tuneOutWake}: ${shown} — ${count} addressed message${count === 1 ? '' : 's'}]`
      : `[${NOTICE_TAG.tuneOutCadence}: ${shown} — ${count} diverted message${count === 1 ? '' : 's'} since your last look]`;
    if (!subName) {
      const hold = this.holdFor(serverId, channelId);
      if (!hold) return;
      const ofChannel = inChannelOf(serverId, channelId);
      const inChannel = (m: Pick<StoredMessage, 'metadata'>): boolean =>
        (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === hold.epochId && ofChannel(m);
      // A held message is stored as it arrives, the resident's turn alive or
      // not, and what arrives while the resident is busy is the traffic a
      // reader is there for.
      this.invokeReaderFork(
        serverId,
        channelId,
        hold.epochId,
        trigger,
        notice,
        this.hooks.getStoredMessages().filter(inChannel),
      );
      // The count restarts once the fork has been handed what was held, as it
      // does below once the subconscious's turn has been asked for. Otherwise
      // every later cadence period still sees this one's count and derives a
      // fork with nothing new to read. A held message a surgery's hold, or a
      // manager waiting for its recovery, keeps in memory wasn't handed: it
      // isn't stored yet. It still counts, so the first cadence period after
      // it is stored hands it.
      this.divertedSinceInvocation.set(key, this.keptInMemory(inChannel));
      return;
    }
    this.hooks.addMessage(
      'user',
      [{ type: 'text', text: notice }],
      { system: true, kind: `tune-out-${trigger}`, channelId },
      subName,
    );
    this.hooks.requestInference(subName, `tune-out ${trigger}: ${shown}`, 'tune-out');
    // Counted from here only once the turn has been asked for, so a turn that
    // throws leaves its messages for the next period's turn.
    this.divertedSinceInvocation.set(key, 0);
    const epochId = this.holdFor(serverId, channelId)?.epochId;
    if (epochId) this.markLook(epochId, serverId, channelId);
  }

  /** How many of the writes the framework keeps in memory (getSurgeryHeldMessages) `keep` keeps; 0 where they can't be read. */
  private keptInMemory(keep: (m: Pick<StoredMessage, 'metadata'>) => boolean): number {
    try {
      return (this.hooks.getSurgeryHeldMessages?.() ?? []).filter(keep).length;
    } catch (err) {
      console.error('[tune-out] could not read the writes a surgery holds in memory, so none is counted:', err);
      return 0;
    }
  }

  /**
   * Count again, from the held messages (all stored, #291), those the reader
   * of the epoch holding this channel now hasn't looked at: for reader
   * forks, those no fork was handed; for the persistent subconscious, those
   * held since its last look (lastLooks). Nothing holding the channel leaves
   * no count.
   */
  private rebuildTally(serverId: string, channelId: string): void {
    const key = this.key(serverId, channelId);
    const hold = this.holdFor(serverId, channelId);
    if (!hold || !this.readerAvailable()) {
      this.divertedSinceInvocation.delete(key);
      return;
    }
    const ofChannel = inChannelOf(serverId, channelId);
    const inEpoch = (m: Pick<StoredMessage, 'metadata'>): boolean =>
      (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === hold.epochId && ofChannel(m);
    const rows = this.hooks.getStoredMessages().filter(inEpoch);
    let count: number;
    if (this.forkReader) {
      count = this.unhandedBacklog(this.handOffKey(hold.epochId, serverId, channelId), rows).length;
    } else {
      const mark = this.lastLooks()?.[hold.epochId]?.[key];
      count = mark === undefined ? rows.length : rows.filter((m) => m.sequence > mark).length;
    }
    this.divertedSinceInvocation.set(key, count);
  }

  private get lastLooksStateId(): string {
    return `tune-out/${this.hooks.primaryName() ?? 'default'}/last-looks`;
  }

  /**
   * The stored last looks. Where they can't be read, none: every held row
   * counts, and nothing is cached, so the next read tries again. Nor is
   * anything written back over the stored record then (markLook, dropLooks,
   * pruneLooks), which would erase the other epochs' and channels' looks.
   */
  private lastLooks(): Record<string, Record<string, number>> | undefined {
    if (this.lastLooksCache !== undefined) return this.lastLooksCache;
    let raw: unknown;
    try {
      raw = this.channelRegistry.readCoordinatorState(this.lastLooksStateId);
    } catch (error) {
      console.error(`[tune-out] the subconscious's last looks (${this.lastLooksStateId}) could not be read:`, error);
      return undefined;
    }
    const looks: Record<string, Record<string, number>> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [epochId, channels] of Object.entries(raw as Record<string, unknown>)) {
        if (!channels || typeof channels !== 'object' || Array.isArray(channels)) continue;
        const marks = Object.entries(channels as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === 'number');
        if (marks.length > 0) looks[epochId] = Object.fromEntries(marks);
      }
    }
    this.lastLooksCache = looks;
    return looks;
  }

  private writeLooks(looks: Record<string, Record<string, number>>): void {
    this.lastLooksCache = looks;
    try {
      this.channelRegistry.writeCoordinatorState(this.lastLooksStateId, looks);
    } catch (error) {
      // The look itself stands. After a restart, this look's messages would
      // count as unseen at the next one.
      console.error(`[tune-out] the subconscious's last looks (${this.lastLooksStateId}) could not be stored:`, error);
    }
  }

  private markLook(epochId: string, serverId: string, channelId: string): void {
    const looks = this.lastLooks();
    if (!looks) return;
    this.writeLooks({ ...looks, [epochId]: { ...looks[epochId], [this.key(serverId, channelId)]: this.hooks.currentSequence() } });
  }

  /** An ended epoch's last looks go with it. */
  private dropLooks(epochId: string): void {
    if (this.hooks.subconsciousName() == null) return;
    const looks = this.lastLooks();
    if (!looks || !(epochId in looks)) return;
    const { [epochId]: _ended, ...rest } = looks;
    this.writeLooks(rest);
  }

  /** At boot: the last looks of epochs no longer active go. */
  private pruneLooks(): void {
    if (this.hooks.subconsciousName() == null) return;
    const looks = this.lastLooks();
    if (!looks) return;
    const active = new Set(this.listActive().map((e) => e.params.epochId));
    const scope = this.getAllExcept();
    if (scope) active.add(scope.params.epochId);
    const kept = Object.fromEntries(Object.entries(looks).filter(([epochId]) => active.has(epochId)));
    if (Object.keys(kept).length !== Object.keys(looks).length) this.writeLooks(kept);
  }

  /**
   * `reader: 'forks'`: hand the framework one invocation. The backlog is
   * the epoch's held messages not yet handed to any fork — each is
   * delivered to exactly one reader — plus the standing dispositions. A
   * cadence look with nothing new is skipped. True when a fork was asked for.
   */
  private invokeReaderFork(
    serverId: string,
    channelId: string,
    epochId: string,
    trigger: ReaderInvocation['trigger'],
    notice: string,
    epochBacklog: StoredMessage[],
  ): boolean {
    if (!this.hooks.invokeReader) return false;
    const key = this.handOffKey(epochId, serverId, channelId);
    const backlog = this.unhandedBacklog(key, epochBacklog);
    if (trigger === 'cadence' && backlog.length === 0) return false;
    // The cursor only moves forward: a returned row handed again can be
    // behind it.
    const cursor = Math.max(this.readerCursor.get(key) ?? -1, ...backlog.map((m) => m.sequence));
    if (backlog.length > 0) this.readerCursor.set(key, cursor);
    const returned = this.readerReturned.get(key);
    if (returned) {
      for (const m of backlog) returned.delete(m.id);
      if (returned.size === 0) this.readerReturned.delete(key);
    }
    const entries = Object.entries(this.readDispositions());
    this.hooks.invokeReader({
      serverId,
      channelId,
      epochId,
      trigger,
      notice,
      backlog,
      dispositions: entries.length > 0 ? entries.map(([k, v]) => `- ${k}: ${v}`).join('\n') : null,
    });
    return true;
  }

  /**
   * What no reader fork has read yet, of the given held messages, oldest
   * first: those past the epoch's cursor for the channel, plus those a
   * failed fork returned.
   */
  private unhandedBacklog(key: string, stored: StoredMessage[]): StoredMessage[] {
    const cursor = this.readerCursor.get(key) ?? -1;
    const returned = this.readerReturned.get(key);
    return stored
      .filter((m) => returned?.has(m.id) || m.sequence > cursor)
      .sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * A reader fork that never read what it was handed: its derive failed, or
   * its run threw before it reported. While the epoch that held the
   * messages is still active, they go back to that epoch's backlog for the
   * channel, and its next invocation for the channel is handed them: the
   * scope's while the scope is active, though the channel's own tune-out
   * has taken the channel meanwhile, and a channel's own tune-out's while it
   * holds the channel. Once the epoch has ended, its cancel's last fork was
   * handed only what no fork had been, so a fork still running then is the
   * only reader its messages had: one late fork is handed them instead
   * (lateFork). Returns how many went back or to the late fork.
   */
  readerFailed(invocation: Pick<ReaderInvocation, 'serverId' | 'channelId' | 'epochId' | 'backlog'>): number {
    const { serverId, channelId, epochId } = invocation;
    const active = this.getAllExcept()?.params.epochId === epochId
      || this.channelRegistry.getTuneOutState(serverId, channelId)?.params.epochId === epochId;
    if (!active) return this.lateFork(invocation);
    const key = this.handOffKey(epochId, serverId, channelId);
    const returned = this.readerReturned.get(key) ?? new Set<string>();
    for (const m of invocation.backlog) returned.add(m.id);
    const count = invocation.backlog.length;
    if (count > 0) {
      this.readerReturned.set(key, returned);
      // They count again toward the next cadence look of the epoch holding
      // the channel, which hands them back. Where another epoch holds it
      // now, they're counted again when the channel comes back to theirs
      // (rebuildTally), and its release hands them in any case.
      const tally = this.key(serverId, channelId);
      if (this.holdFor(serverId, channelId)?.epochId === epochId) {
        this.divertedSinceInvocation.set(tally, (this.divertedSinceInvocation.get(tally) ?? 0) + count);
      }
    }
    return count;
  }

  /**
   * A fork that failed after its epoch ended: one late fork is handed what it
   * was, with a notice saying a reader handed them failed after the tune-out
   * ended. Every held message is stored as it arrives (#291), so what it was
   * handed is what the late fork is. A late fork's own failure derives no
   * other, so a reader that keeps failing costs one more fork, not a chain
   * of them. Returns how many the late fork was handed.
   */
  private lateFork(invocation: Pick<ReaderInvocation, 'serverId' | 'channelId' | 'epochId' | 'backlog'>): number {
    if (!this.hooks.invokeReader || this.lateForks.has(invocation)) return 0;
    const { serverId, channelId, epochId } = invocation;
    const backlog = [...invocation.backlog].sort((a, b) => a.sequence - b.sequence);
    const count = backlog.length;
    if (count === 0) return 0;
    const these = count === 1 ? 'This message was' : `These ${count} messages were`;
    const notice = `[${NOTICE_TAG.tuneOutCancelled}: ${this.shown(serverId, channelId)} — ${these} handed to a reader that `
      + `failed after the tune-out ended, so no reader has read ${count === 1 ? 'it' : 'them'} yet.]`;
    const entries = Object.entries(this.readDispositions());
    const late: ReaderInvocation = {
      serverId,
      channelId,
      epochId,
      trigger: 'cancel',
      notice,
      backlog,
      dispositions: entries.length > 0 ? entries.map(([k, v]) => `- ${k}: ${v}`).join('\n') : null,
      epochEnded: true,
    };
    this.lateForks.add(late);
    this.hooks.invokeReader(late);
    return count;
  }

  // ==========================================================================
  // Dispositions (standing notes, snapshot slot)
  // ==========================================================================

  private dispositionsCache: Record<string, string> | null = null;

  private get dispositionsStateId(): string {
    return `subconscious/${this.hooks.primaryName() ?? 'default'}/dispositions`;
  }

  /**
   * The dispositions as a fixed system-position ContextInjection for the
   * subconscious's compiles (antra: deliver changes, never let them wash
   * away — it has no long-term memory, so they must not live in window
   * content). Bytes change only when a disposition changes: KV-friendly.
   * A failed read of the stored map throws, so the compile stops rather than
   * run without them.
   */
  getDispositionsInjection(): {
    namespace: string;
    position: 'system';
    content: Array<{ type: 'text'; text: string }>;
  } | null {
    const dispositions = this.readDispositions();
    const entries = Object.entries(dispositions);
    if (entries.length === 0) return null;
    return {
      namespace: 'dispositions',
      position: 'system',
      content: [{
        type: 'text',
        text: `[${NOTICE_TAG.standingDispositions}]\n${entries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`,
      }],
    };
  }

  private readDispositions(): Record<string, string> {
    if (this.dispositionsCache) return this.dispositionsCache;
    let raw: unknown;
    try {
      raw = this.channelRegistry.readCoordinatorState(this.dispositionsStateId);
    } catch (error) {
      // A failed read is not an empty map, and nothing is cached, so the next
      // read asks the store again. Taken as empty, it would compile the
      // subconscious without its dispositions until a restart, and the next
      // noteDisposition would write that empty map over the stored one.
      throw new Error(`the stored dispositions (${this.dispositionsStateId}) could not be read: ${thrownReason(error)}`, { cause: error });
    }
    this.dispositionsCache = (raw && typeof raw === 'object') ? raw as Record<string, string> : {};
    return this.dispositionsCache;
  }

  noteDisposition(key: string, text: string): void {
    const dispositions = { ...this.readDispositions() };
    if (text === '') {
      delete dispositions[key];
    } else {
      dispositions[key] = text;
    }
    // Stored before it's cached: a write that fails leaves the cache and the
    // store as they were, so the note is in effect nowhere.
    try {
      this.channelRegistry.writeCoordinatorState(this.dispositionsStateId, dispositions);
    } catch (error) {
      throw new Error(`the dispositions (${this.dispositionsStateId}) could not be stored: ${thrownReason(error)}`, { cause: error });
    }
    this.dispositionsCache = dispositions;
  }

  // ==========================================================================
  // Subconscious tool dispatch
  // ==========================================================================

  async handleSubconsciousTool(
    name: string,
    input: Record<string, unknown>,
    /** The calling turn's own channels, for a call made inside it (the framework's callOwnChannels). */
    own: readonly ChannelRef[] = [],
    /** The calling agent: the persistent subconscious, or a reader fork. */
    caller?: string,
    /** A reader fork, with the epoch it was derived to read, if any: it ends and posts only through that epoch's
     *  hold (forkRefusal). The persistent subconscious, which reads every epoch, passes none. */
    fork?: { epochId?: string },
  ): Promise<{ success: boolean; data?: unknown; error?: string; isError?: boolean }> {
    switch (name) {
      case 'deliver_summary': {
        const text = String(input.text ?? '').trim();
        const channelId = String(input.channelId ?? '');
        if (!text) {
          return {
            success: false,
            error: 'Nothing was delivered: deliver_summary needs the summary in "text".',
            isError: true,
          };
        }
        const subName = this.hooks.subconsciousName();
        // Verbatim, under its own participant name, into the resident's window
        // (or, from a reader fork, as its attributed mail), tagged with the
        // channel the name means and its server, since the framework reads a
        // conversational row's channel (repinChannel). The name means what it
        // means to every channel tool: inside the calling turn, the id of one
        // of the turn's own channels means that channel, refused where its
        // server no longer registers it or the turn has channels with that id
        // on two servers (ownChannelFor); otherwise a name several registered
        // channels answer to is refused with them (sharedNameRefusalFor). So
        // no row is left for a re-pin to read as another server's channel. A
        // name no registered channel answers to is kept as given, with no
        // server, which a re-pin reads by name when it weighs the row, as it
        // reads any message without its server.
        if (!subName && !(caller && this.hooks.deliverFromReader)) {
          return { success: false, error: 'Nothing was delivered: no reader is configured here.', isError: true };
        }
        const mine = this.channelRegistry.ownChannelFor(channelId, own, 'deliver');
        if (mine && 'error' in mine) return { success: false, error: mine.error, isError: true };
        const shared = mine ? undefined : this.channelRegistry.sharedNameRefusalFor(channelId, 'nothing was delivered');
        if (shared) return { success: false, error: shared, isError: true };
        const [named] = mine ? [mine.channel] : this.channelRegistry.channelsNamed(channelId);
        const metadata = {
          kind: 'subconscious-summary',
          ...(named ? { channelId: named.channelId, serverId: named.serverId } : { channelId }),
        };
        if (subName) {
          this.hooks.addMessage(subName, [{ type: 'text', text }], metadata);
          return { success: true, data: { delivered: true } };
        }
        // A reader fork's report: attributed mail under its own name. The fork
        // counts as having reported only once the mail is held: a delivery
        // that throws is an error result to the fork, and its prose is then
        // still delivered as its report when it ends (#546, probe R14).
        this.hooks.deliverFromReader!(caller!, [{ type: 'text', text }], metadata);
        this.readerReports.add(caller!);
        return { success: true, data: { delivered: true } };
      }
      case 'cancel_tuneout': {
        const name = String(input.channelId ?? '');
        const note = typeof input.text === 'string' && input.text.trim() ? input.text.trim() : undefined;
        const endScope = (): { success: boolean; data?: unknown; error?: string; isError?: boolean } => {
          const scope = this.getAllExcept();
          const refused = fork && scope
            ? this.forkRefusal(fork, { epochId: scope.params.epochId }, 'cancel', "the all-except hold isn't the hold you were started to read")
            : undefined;
          if (refused) return { success: false, error: refused, isError: true };
          const result = this.cancelAllExcept('subconscious', cancelledBy(caller), note, caller);
          if (!result.ok) return { success: false, error: result.error, isError: true };
          return result.deferred
            ? { success: true, data: { waiting: true, scope: 'all-except', note: cancelWaitsNote('The all-except hold', result.noteDropped === true, note === undefined ? undefined : fork ? 'fork' : 'persistent', this.markerPending !== undefined) } }
            : { success: true, data: { cancelled: true, scope: 'all-except' } };
        };
        // A call naming the all-except scope ends that hold outright, as the
        // tool describes it and as the resident's tune_out cancel does: the
        // channel it names, tuned out on its own or not, doesn't turn it
        // into that channel's cancel, and with no hold it ends nothing.
        if (input.scope === 'all-except') return endScope();
        const serverId = typeof input.serverId === 'string' && input.serverId ? input.serverId : undefined;
        // The name means what it means to every channel tool, the
        // resident's tune_out included: with a serverId, that server's
        // channel with the id; inside the calling turn, the id of one of the
        // turn's own channels means that channel (ownChannelFor); otherwise a
        // name several registered channels answer to picks none of them
        // (channelsNamed), whichever of them is tuned out, never taken to be
        // the tuned-out one. A name that picks no channel, such a name or one
        // of the turn's own channels that ownChannelFor refuses, is refused,
        // unless the call names the all-except scope, which ends that hold
        // below.
        const mine = serverId ? undefined : this.channelRegistry.ownChannelFor(name, own);
        const refusal = mine && 'error' in mine ? mine.error
          : serverId || mine ? undefined : this.channelRegistry.sharedNameRefusalFor(name);
        const named = serverId ? [{ serverId, channelId: name }]
          : mine && 'channel' in mine ? [mine.channel] : this.channelRegistry.channelsNamed(name);
        const channel = refusal ? undefined : named[0];
        if (!channel || !this.channelRegistry.getTuneOutState(channel.serverId, channel.channelId)) {
          // The reader keeps its latitude over the all-except hold too: a
          // channel it holds (or the scope named as the channel) ends the
          // scope. A call naming the scope "channel" ends only a channel's
          // own tune-out, so on a channel only the scope holds it ends
          // nothing.
          const scope = this.getAllExcept();
          const heldByScope = scope && (name === 'all-except'
            || (channel !== undefined && this.holdFor(channel.serverId, channel.channelId)?.epochId === scope.params.epochId));
          if (!heldByScope) return { success: false, error: refusal ?? this.notTunedOut(JSON.stringify(name), 'the resident'), isError: true };
          if (input.scope === 'channel') {
            const shown = channel ? this.quotedShown(channel.serverId, channel.channelId) : JSON.stringify(name);
            return {
              success: false,
              error: `Nothing was cancelled: ${shown} isn't tuned out on its own, and scope "channel" ends only a channel's own `
                + 'tune-out. The all-except hold holds it, and calling cancel_tuneout with scope "all-except" ends that hold.',
              isError: true,
            };
          }
          return endScope();
        }
        const held = this.channelRegistry.getTuneOutState(channel.serverId, channel.channelId)!;
        const refused = fork && this.forkRefusal(fork, { epochId: held.params.epochId }, 'cancel',
          `the tune-out on ${this.quotedShown(channel.serverId, channel.channelId)} isn't the hold you were started to read`);
        if (refused) return { success: false, error: refused, isError: true };
        const result = this.cancel(channel.serverId, channel.channelId, 'subconscious', cancelledBy(caller), note, caller);
        if (!result.ok) return { success: false, error: result.error, isError: true };
        return result.deferred
          // The server it resolved to, which a boot reads to tell two
          // servers' channels of one id apart (askedCancelOf).
          ? { success: true, data: { waiting: true, serverId: channel.serverId, note: cancelWaitsNote('The tune-out', result.noteDropped === true, note === undefined ? undefined : fork ? 'fork' : 'persistent', this.markerPending !== undefined) } }
          : { success: true, data: { cancelled: true } };
      }
      case 'note_disposition': {
        const key = String(input.key ?? '').trim();
        if (!key) {
          return {
            success: false,
            error: 'Nothing was recorded: note_disposition needs a "key", a short stable name for the note, such as '
              + '"busy-channels". To delete a note, call it with that note\'s key and an empty "text".',
            isError: true,
          };
        }
        try {
          this.noteDisposition(key, String(input.text ?? ''));
        } catch (error) {
          // For the subconscious first: what became of its note, and that a
          // later call may land. The store's own reason follows, for an operator.
          // The note may set, change or remove a disposition, so what stays in
          // effect is whatever was there before, if anything.
          return {
            success: false,
            isError: true,
            error: `The change to the disposition ${JSON.stringify(key)} wasn't recorded, so the dispositions stay as they were. ` +
              `Noting it again may work once the store can be read and written. The store's error: ${thrownReason(error)}`,
          };
        }
        return { success: true, data: { noted: key } };
      }
      case 'speak_in_channel': {
        if (!this.hooks.allowChannelSpeech()) {
          // The setting's name is the host's, for its log; the subconscious
          // reads what it can do instead.
          console.warn('[tune-out] speak_in_channel refused: FrameworkConfig.subconscious.allowChannelSpeech is off');
          return {
            success: false,
            isError: true,
            error: "Nothing was posted: speak_in_channel is turned off for you in the resident's configuration, and "
              + "calling it again won't change that. The resident can speak there. deliver_summary puts your text in "
              + "the resident's context, and cancel_tuneout ends the tune-out and delivers its backlog to the resident.",
          };
        }
        const channelId = String(input.channelId ?? '');
        const text = String(input.text ?? '').trim();
        if (!text) {
          return { success: false, error: 'Nothing was posted: speak_in_channel needs the message in "text".', isError: true };
        }
        // Inside the calling turn, the id of one of the turn's own channels
        // means that channel, as for every channel tool (ownChannelFor).
        const mine = this.channelRegistry.ownChannelFor(channelId, own, 'publish');
        if (mine && 'error' in mine) return { success: false, error: mine.error, isError: true };
        if (fork) {
          const named = mine ? [mine.channel] : this.channelRegistry.channelsNamed(channelId);
          const at = named.length === 1 ? named[0] : undefined;
          const hold = at ? this.holdFor(at.serverId, at.channelId) : null;
          const shown = at ? this.quotedShown(at.serverId, at.channelId) : JSON.stringify(channelId);
          const refused = (at || fork.epochId === undefined) && this.forkRefusal(fork, hold, 'speech', hold
            ? `${shown} is held by a hold other than the one you were started to read`
            : `${shown} isn't held now`);
          if (refused) return { success: false, error: refused, isError: true };
        }
        return this.channelRegistry.publishForAgent(mine ? mine.channel : channelId, text, this.hooks.subconsciousName() ?? caller ?? 'Subconscious');
      }
      default:
        return { success: false, error: `unknown reader tool: ${name}`, isError: true };
    }
  }

  /**
   * Why a reader fork may not act through `hold` (the epoch holding what its
   * call names, or null): a fork ends and posts only through the hold of the
   * epoch it was derived to read, and one derived for none acts through no
   * hold. Undefined where the hold is its own. `why` says, for the fork, how
   * what its call names isn't its own hold; its reports stay open to it.
   */
  private forkRefusal(
    fork: { epochId?: string },
    hold: { epochId: string } | null,
    act: 'cancel' | 'speech',
    why: string,
  ): string | undefined {
    if (fork.epochId !== undefined && hold?.epochId === fork.epochId) return undefined;
    const nothing = act === 'cancel' ? 'Nothing was cancelled' : 'Nothing was posted';
    const report = `Your report can say what you would ${act === 'cancel' ? 'judge of it' : 'have posted'}, and the resident reads it.`;
    if (fork.epochId === undefined) {
      return `${nothing}: you weren't started to read a tune-out, so there's no hold you can `
        + `${act === 'cancel' ? 'end' : 'post through'}. ${report}`;
    }
    const rule = act === 'cancel' ? 'a reader ends only its own' : 'a reader posts only into a channel its own hold holds';
    return `${nothing}: ${why}, and ${rule}. ${report}`;
  }

  /**
   * A cancel of a channel that isn't tuned out, by the name, quoted, the caller gave
   * or knows it by: which channels are, so the next call can name one, and
   * how a tune-out ends without one. `backlogTo`
   * names the resident as the message's reader knows it: "you" to the
   * resident, "the resident" to the subconscious. It speaks of connected
   * channels because listActive reads the registered ones: removing a server
   * drops its channels and keeps their tune-outs, so a tune-out there is in
   * neither this list nor the name's lookup (channelsNamed, which reads the
   * registered channels too), and the text claims nothing about it.
   */
  private notTunedOut(quoted: string, backlogTo: 'you' | 'the resident'): string {
    const active = this.listActive().map((e) => this.quotedShown(e.serverId, e.channelId));
    const opening = active.length === 0
      ? 'no connected channel is tuned out now.'
      : `no connected channel ${quoted} is tuned out. Connected channels tuned out now: `
        + `${active.join(', ')}.`;
    return `Nothing was cancelled: ${opening} A tune-out also ends by itself when its duration runs out, or at the `
      + `first wake past its wake budget, and its backlog goes to ${backlogTo} then.`;
  }

  /**
   * The reader ended, not the framework: its turns stop (cadence and
   * coalescing wakes). The framework then releases every hold with
   * releaseAll ("its reader ended"); a hold whose release fails keeps its end
   * time, which releases it to the resident with no reader.
   */
  stopReader(): void {
    for (const timer of this.cadenceTimers.values()) clearTimeout(timer);
    this.cadenceTimers.clear();
    for (const { timer } of this.pendingWakes.values()) clearTimeout(timer);
    this.pendingWakes.clear();
  }

  /**
   * Stop all timers (framework shutdown), tell each waiting cancel's note
   * lost, keep the persistent subconscious's notices in the store, and
   * stamp the stop (writeStopStamp). A second stop stamps nothing: the
   * first one's notices are no longer in memory to say what it kept.
   */
  stop(): void {
    const again = this.stopped;
    this.stopped = true;
    if (this.releaseRetry) {
      clearTimeout(this.releaseRetry);
      this.releaseRetry = null;
    }
    // A cancel still waiting for held writes ends nothing: the tune-out stays
    // in force on disk, for the next boot, which doesn't run the cancel
    // again. A note it carries is lost with it, and told lost as any other
    // (dropDeferred: `stopped`, or `hold-ended` where its hold ended without
    // it), the notice kept, not written (tellNoteLost). A loss notice not
    // written yet for the persistent subconscious, that one included, stays
    // kept in the store (writeLossRecord), for the next boot to write
    // (restoreLossNotices); a reader fork's, whose run doesn't outlast the
    // stop, is dropped, as is one the store couldn't keep, which the stamp
    // then leaves out (writeStopStamp), for the next boot to tell. Each is
    // logged, naming its author.
    const waiting = [...this.deferredCancels.values()];
    this.deferredCancels.clear();
    const unaccounted = new Set<string>();
    for (const entry of waiting) {
      if (entry.note === undefined || entry.noteSettled) continue;
      try {
        let now: string | undefined;
        let read = true;
        try {
          now = entry.for.current();
        } catch {
          read = false;
        }
        this.dropDeferred(entry, read && now !== entry.for.epochId
          ? { reason: 'hold-ended', ...(now !== undefined ? { current: now } : {}) }
          : { reason: 'stopped' });
      } catch (err) {
        unaccounted.add(entry.for.epochId);
        console.error(`[tune-out] stopping: the note left with the cancel of ${entry.what} is lost, and its loss could not be kept: ${thrownReason(err)}`);
      }
    }
    const recorded = this.writeLossRecord('stop');
    if (!again) this.writeStopStamp(recorded, unaccounted);
    this.markerPending = undefined;
    for (const [author, kept] of this.lossNotices) {
      for (const notice of kept) {
        const told = `the notice telling ${author} ${lossSubject(notice)}`;
        if (notice.persistent && recorded) {
          console.error(`[tune-out] stopping: ${told} isn't written yet, and is kept in the store for the next boot to write`);
        } else if (notice.persistent) {
          console.error(`[tune-out] stopping: ${told} was never written, and the store couldn't keep it, so it is dropped`);
        } else {
          console.error(`[tune-out] stopping: ${told} was never written, and is dropped: a reader fork's run doesn't outlast a stop`);
        }
      }
    }
    this.lossNotices.clear();
    if (this.deferredRetry !== undefined) clearTimeout(this.deferredRetry);
    this.deferredRetry = undefined;
    for (const timer of this.cadenceTimers.values()) clearTimeout(timer);
    this.cadenceTimers.clear();
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    for (const { timer } of this.pendingWakes.values()) clearTimeout(timer);
    this.pendingWakes.clear();
  }
}

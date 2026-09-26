/**
 * Prose outbox — durable, ordered, bounded retry for plain speech that could
 * not be delivered when it was written (FrameworkConfig.proseOutbox, opt-in).
 *
 * ChannelRegistry.routeSpeech is the single delivery point for every prose
 * path; when a publish fails in a way that may be transient, it hands the
 * speech here instead of dropping it. The outbox:
 *   - persists each entry to a JSON file before routeSpeech returns, so a
 *     restart loses nothing. Deliberately NOT Chronicle state: that is
 *     branch-local, and a historical rollback would resurrect entries that
 *     were already delivered (double posts) or drop ones that were not
 *     (same reasoning as recovery/discord-awareness-outbox.ts);
 *   - keeps per-channel FIFO order: newer speech to a channel with queued
 *     entries waits behind them, never overtakes;
 *   - retries only what is safe to resend: `not-sent` (the request provably
 *     never reached the server), or `unknown` (timed out; may have posted)
 *     when the server confirms it honours `idempotencyKey`;
 *   - expires the resident's own words past `maxAgeMs` (a stale reply may
 *     no longer fit the conversation), but keeps automatic notices until
 *     delivered by default (`noticeMaxAgeMs`): what they report stays true,
 *     and they are written at the START of an outage, so a shared age limit
 *     drops exactly the entries that report drops (the Librarian,
 *     2026-09-26);
 *   - caps its size, dropping the oldest of the resident's own entries
 *     before any notice, and tells the resident either way.
 *
 * Pure bookkeeping: the registry performs the publishes and wires events to
 * resident notices.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function defaultProseOutboxPath(storePath: string): string {
  return join(storePath, 'recovery', 'prose-outbox.json');
}

export interface ProseOutboxConfig {
  /** Keep failed speech and retry it. Default false. */
  enabled: boolean;
  /** Queue file. Defaults to `<storePath>/recovery/prose-outbox.json`;
   *  without either the queue is memory-only (lost on restart). */
  path?: string;
  /** The resident's own speech and sends older than this are not sent (default 6 h). */
  maxAgeMs?: number;
  /** Automatic notices (entries marked `notice`) older than this are not
   *  sent. Default: no age limit, kept until delivered (still bounded by
   *  the size caps). */
  noticeMaxAgeMs?: number;
  /** Cap across all agents (default 200); the oldest entry expires first. */
  maxEntries?: number;
  /** Cap per agent (default 50). */
  maxEntriesPerAgent?: number;
  /** First retry delay; doubles per attempt (default 60 s). */
  retryBaseMs?: number;
  /** Retry delay ceiling (default 15 min). */
  retryMaxMs?: number;
  /**
   * MCPL tool names (unprefixed, e.g. "send_message") whose calls are held
   * the same way when the server can't be reached. Only list tools that are
   * safe to perform later: sends, never deletes. A queued call returns a
   * "queued" result to the agent instead of an error.
   */
  tools?: string[];
}

/** Why a failed publish may be retried. */
export type OutboxOutcome =
  /** The request never reached the server: resending cannot duplicate. */
  | 'not-sent'
  /** The server may have posted it (timeout, partial send). */
  | 'unknown';

/** How a failed publish should be handled. */
export type PublishFailureClass = OutboxOutcome | 'permanent';

export interface OutboxEntry {
  /** Doubles as the publish idempotencyKey (sent on the first attempt too). */
  id: string;
  conversationId: string;
  channelId: string;
  text: string;
  /** When the speech was first sent for delivery (ms epoch). */
  writtenAt: number;
  attempts: number;
  nextAttemptAt: number;
  outcome: OutboxOutcome;
  lastError: string;
  /** Present for a queued tool call (config.tools); absent for plain speech. */
  tool?: { serverId: string; name: string; input: Record<string, unknown> };
  /** An automatic notice posted by the framework (e.g. a failure notice),
   *  not the resident's own words: expires by `noticeMaxAgeMs`, and is
   *  dropped for space only after the resident's own entries. */
  notice?: true;
}

export type OutboxEvent =
  /** `expiresAt` is Infinity for an entry with no age limit. */
  | { kind: 'queued'; entry: OutboxEntry; reason: string; expiresAt: number }
  | { kind: 'delivered-late'; entry: OutboxEntry; deliveredAt: number; messageId?: string }
  /** Dropped without delivery: expired, over a cap, a permanent error on
   *  retry, or an unknown outcome the server can't dedupe. `mayHaveArrived`
   *  is true when some attempt's outcome was unknown. */
  | {
      kind: 'dropped'; entry: OutboxEntry; reason: string; mayHaveArrived: boolean;
      /** Where the undelivered text was saved (queue file's directory,
       *  `undelivered/`), when there is a queue file. */
      savedTo?: string;
    };

interface PersistedState {
  version: 1;
  entries: OutboxEntry[];
  /** Dedupe scope (serverId for publish, serverId#tool for a tool) → the
   *  latest result from that scope echoed idempotencyKey. */
  idempotentServers: Record<string, boolean>;
}

const HOUR = 3_600_000;
const MAX_ERROR = 300;

/**
 * Classify a thrown publish error. Conservative: anything not recognisably
 * pre-send or outcome-unknown is permanent (the existing failure marker).
 */
export function classifyPublishError(err: unknown): PublishFailureClass {
  const msg = String((err as { message?: unknown } | null)?.message ?? err ?? '');
  // The host could not even write the request (server-connection.ts), or the
  // connector refused before touching the platform (discord-mcpl
  // waitForDiscord / pre-connect network errors).
  if (/Cannot send request: connection to .* is closed/.test(msg)) return 'not-sent';
  // The connection died with the request in flight: the server may have
  // posted before it went (server-connection.ts close/exit paths).
  if (/closed while awaiting response|disconnected unexpectedly .* while awaiting/.test(msg)) return 'unknown';
  if (/is not connected right now|not connected|reconnecting/i.test(msg)) return 'not-sent';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|Connect Timeout Error/.test(msg)) return 'not-sent';
  // The request left and no answer came back, or only part of it posted.
  if (/did not respond to .* within \d+ms/.test(msg)) return 'unknown';
  if (/partially completed|partial send/i.test(msg)) return 'unknown';
  if (/ECONNRESET|socket hang up|ETIMEDOUT|timed out/i.test(msg)) return 'unknown';
  return 'permanent';
}

export class ProseOutbox {
  readonly maxAgeMs: number;
  readonly noticeMaxAgeMs: number;
  private readonly maxEntries: number;
  private readonly maxPerAgent: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private entries: OutboxEntry[] = [];
  private idempotentServers: Record<string, boolean> = {};

  constructor(
    config: ProseOutboxConfig,
    private readonly path: string | undefined,
    private readonly onEvent: (event: OutboxEvent) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.maxAgeMs = config.maxAgeMs ?? 6 * HOUR;
    this.noticeMaxAgeMs = config.noticeMaxAgeMs ?? Number.POSITIVE_INFINITY;
    this.maxEntries = Math.max(1, config.maxEntries ?? 200);
    this.maxPerAgent = Math.max(1, config.maxEntriesPerAgent ?? 50);
    this.retryBaseMs = Math.max(1, config.retryBaseMs ?? 60_000);
    this.retryMaxMs = Math.max(this.retryBaseMs, config.retryMaxMs ?? 15 * 60_000);
    this.load();
  }

  get size(): number {
    return this.entries.length;
  }

  /** New id for a first attempt (so a timed-out first attempt can be deduped). */
  static newId(): string {
    return randomUUID();
  }

  hasQueued(channelId: string): boolean {
    return this.entries.some((e) => e.channelId === channelId);
  }

  /** `scope`: serverId for publishes, `serverId#tool` for a tool: a server
   *  may dedupe one send path and not another. */
  isIdempotent(scope: string): boolean {
    return this.idempotentServers[scope] === true;
  }

  /** Record whether the scope's latest result echoed the key. */
  noteIdempotency(scope: string, confirmed: boolean): void {
    if ((this.idempotentServers[scope] === true) === confirmed) return;
    if (confirmed) this.idempotentServers[scope] = true;
    else delete this.idempotentServers[scope];
    this.persist();
  }

  /** Queue speech. Enforces caps (the oldest entries are dropped first). */
  enqueue(
    input: {
      id: string; conversationId: string; channelId: string; text: string; writtenAt: number;
      tool?: OutboxEntry['tool'];
      notice?: true;
    },
    outcome: OutboxOutcome,
    reason: string,
  ): OutboxEntry {
    const now = this.now();
    const entry: OutboxEntry = {
      ...input,
      attempts: 1,
      nextAttemptAt: now + this.retryBaseMs,
      outcome,
      lastError: reason.slice(0, MAX_ERROR),
    };
    this.entries.push(entry);
    const overflow: OutboxEntry[] = [];
    const agentEntries = this.entries.filter((e) => e.conversationId === entry.conversationId);
    overflow.push(...evictionOrder(agentEntries).slice(0, Math.max(0, agentEntries.length - this.maxPerAgent)));
    this.entries = this.entries.filter((e) => !overflow.includes(e));
    const globalOver = evictionOrder(this.entries).slice(0, Math.max(0, this.entries.length - this.maxEntries));
    overflow.push(...globalOver);
    this.entries = this.entries.filter((e) => !globalOver.includes(e));
    this.persist();
    for (const e of overflow) this.emitDropped(e, 'the delivery queue is full', e.outcome === 'unknown');
    if (this.entries.includes(entry)) {
      this.onEvent({ kind: 'queued', entry, reason, expiresAt: this.expiresAt(entry) });
    }
    return entry;
  }

  /**
   * Entries ready for an attempt: the head of each channel's queue, if due.
   * Expired entries are dropped first (whole queue, not only heads).
   */
  due(): OutboxEntry[] {
    this.expire();
    const now = this.now();
    const heads = new Map<string, OutboxEntry>();
    for (const e of this.entries) if (!heads.has(e.channelId)) heads.set(e.channelId, e);
    return [...heads.values()].filter((e) => e.nextAttemptAt <= now);
  }

  /** Earliest time any head becomes due (for scheduling), or undefined. */
  nextDueAt(): number | undefined {
    const heads = new Map<string, OutboxEntry>();
    for (const e of this.entries) if (!heads.has(e.channelId)) heads.set(e.channelId, e);
    let min: number | undefined;
    for (const e of heads.values()) min = min === undefined ? e.nextAttemptAt : Math.min(min, e.nextAttemptAt);
    return min;
  }

  /** Make every head due now (a server came back). */
  expedite(channelIds?: ReadonlySet<string>): void {
    const now = this.now();
    let changed = false;
    for (const e of this.entries) {
      if (channelIds && !channelIds.has(e.channelId)) continue;
      if (e.nextAttemptAt > now) { e.nextAttemptAt = now; changed = true; }
    }
    if (changed) this.persist();
  }

  delivered(id: string, messageId?: string): void {
    const entry = this.take(id);
    if (!entry) return;
    this.onEvent({ kind: 'delivered-late', entry, deliveredAt: this.now(), ...(messageId ? { messageId } : {}) });
  }

  /** A retry failed again but may still succeed later. */
  retryLater(id: string, outcome: OutboxOutcome, error: string): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.attempts++;
    // Once any attempt's outcome is unknown, it stays unknown.
    if (outcome === 'unknown') e.outcome = 'unknown';
    e.lastError = error.slice(0, MAX_ERROR);
    const delay = Math.min(this.retryBaseMs * 2 ** (e.attempts - 1), this.retryMaxMs);
    e.nextAttemptAt = this.now() + delay;
    this.persist();
  }

  drop(id: string, reason: string, mayHaveArrived?: boolean): void {
    const entry = this.take(id);
    if (!entry) return;
    this.emitDropped(entry, reason, mayHaveArrived ?? entry.outcome === 'unknown');
  }

  /**
   * Giving up must not lose the words: keep a copy beside the queue file
   * (`undelivered/`), and hand the event the path. The notice to the agent
   * carries the text itself, so nothing depends on the agent keeping its
   * own shadow copy (the Librarian's question: "where does the text go?").
   */
  private emitDropped(entry: OutboxEntry, reason: string, mayHaveArrived: boolean): void {
    let savedTo: string | undefined;
    if (this.path) {
      try {
        const dir = join(dirname(this.path), 'undelivered');
        mkdirSync(dir, { recursive: true });
        savedTo = join(dir, `${new Date(entry.writtenAt).toISOString().replace(/[:.]/g, '-')}-${entry.id}.json`);
        writeFileSync(savedTo, `${JSON.stringify({
          conversationId: entry.conversationId,
          channelId: entry.channelId,
          writtenAt: new Date(entry.writtenAt).toISOString(),
          droppedAt: new Date(this.now()).toISOString(),
          reason,
          mayHaveArrived,
          text: entry.text,
          ...(entry.tool ? { tool: entry.tool } : {}),
        }, null, 2)}\n`, { mode: 0o600 });
      } catch (err) {
        console.error('[prose-outbox] failed to save undelivered text:', err);
        savedTo = undefined;
      }
    }
    this.onEvent({ kind: 'dropped', entry, reason, mayHaveArrived, ...(savedTo ? { savedTo } : {}) });
  }

  snapshot(): readonly OutboxEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** When an entry stops being sent: by class (Infinity = no age limit). */
  expiresAt(entry: OutboxEntry): number {
    return entry.writtenAt + (entry.notice ? this.noticeMaxAgeMs : this.maxAgeMs);
  }

  private expire(): void {
    const now = this.now();
    const expired = this.entries.filter((e) => this.expiresAt(e) < now);
    if (expired.length === 0) return;
    this.entries = this.entries.filter((e) => !expired.includes(e));
    this.persist();
    for (const e of expired) this.emitDropped(e, 'it was too old to send', e.outcome === 'unknown');
  }

  private take(id: string): OutboxEntry | undefined {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return undefined;
    const [entry] = this.entries.splice(i, 1);
    this.persist();
    return entry;
  }

  private load(): void {
    if (!this.path) return;
    let state: Partial<PersistedState> | null;
    try {
      state = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PersistedState> | null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[prose-outbox] unreadable queue file ${this.path}; starting empty:`, error);
      }
      return;
    }
    if (!state || state.version !== 1 || !Array.isArray(state.entries)) return;
    this.entries = state.entries.filter(isEntry);
    if (state.idempotentServers && typeof state.idempotentServers === 'object') {
      for (const [k, v] of Object.entries(state.idempotentServers)) if (v === true) this.idempotentServers[k] = true;
    }
  }

  private persist(): void {
    if (!this.path) return;
    const state: PersistedState = {
      version: 1,
      entries: this.entries,
      idempotentServers: this.idempotentServers,
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (err) {
      console.error('[prose-outbox] failed to persist queue:', err);
    }
  }
}

/** Order in which entries give way to a size cap: the resident's own words
 *  oldest first, then notices oldest first (a notice is short and reports a
 *  failure the room otherwise never hears about). */
function evictionOrder(entries: readonly OutboxEntry[]): OutboxEntry[] {
  return [...entries.filter((e) => !e.notice), ...entries.filter((e) => e.notice)];
}

function isEntry(v: unknown): v is OutboxEntry {
  const e = v as Partial<OutboxEntry> | null;
  return !!e && typeof e.id === 'string' && typeof e.conversationId === 'string' &&
    typeof e.channelId === 'string' && typeof e.text === 'string' &&
    typeof e.writtenAt === 'number' && typeof e.attempts === 'number' &&
    typeof e.nextAttemptAt === 'number' && (e.outcome === 'not-sent' || e.outcome === 'unknown') &&
    typeof e.lastError === 'string' &&
    (e.notice === undefined || e.notice === true) &&
    (e.tool === undefined || (
      typeof e.tool === 'object' && e.tool !== null && typeof e.tool.serverId === 'string' &&
      typeof e.tool.name === 'string' && typeof e.tool.input === 'object' && e.tool.input !== null
    ));
}

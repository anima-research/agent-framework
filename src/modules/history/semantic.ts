/**
 * Semantic (embedding) search for HistoryModule, backed by a shared remote
 * embed-service (one per fleet; the index lives server-side, keyed by a
 * per-store namespace).
 *
 * Two pieces:
 *  - `SemanticIndexClient` — thin HTTP client for the service's index API
 *    (`/v1/index/{ns}/upsert|search|stats`).
 *  - `SemanticIndexer` — incremental sync from the resident's chronicle into
 *    that namespace. Messages are watermarked by TIMESTAMP (chronicle's native
 *    time index is the only cheap "what's new" query), with a re-scan overlap
 *    so a message stamped slightly out of order is still picked up; the
 *    service dedups by id + text hash, so re-sending is free. Summaries are
 *    watermarked by `createdMs` (a fresh L3 spans months of old timestamps —
 *    its creation time is the only monotonic signal). Both watermarks are
 *    kept in the module's state, which follows the store's branches, so each
 *    branch sends its own messages and summaries. A branch made at an earlier
 *    point, as an undo makes one, mints summary ids its parent already used,
 *    so a summary is keyed `sum:<id>@<created>`.
 *
 * What gets embedded per message: text blocks verbatim, plus the string
 * arguments of the agent's private-prose tools (think / journal / skip_reply
 * / private_note) labelled `[think] …` — that is the resident's own diary and
 * is exactly what "what did I think about X" should find. The words of a
 * speech tool's call (send-tools.ts), labelled by tool, such as
 * `[send_message] …`, since with prose routing disabled the resident speaks
 * through them.
 * tool_result payloads, other tool arguments, thinking blocks and media are
 * skipped.
 *
 * Failure posture: the service being down never breaks the module. Sync ticks
 * log and back off; `semantic_search` returns a clean tool error.
 */

import type { ContextManager, StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { safeSlice } from '../../safe-slice.js';
import { speechOf } from '../../send-tools.js';
import { storedInjectionMarkOf } from '../../stored-injections.js';

export interface SemanticIndexConfig {
  /** Base URL of the embed-service, e.g. `http://100.90.161.34:8804`. */
  url: string;
  /** Bearer token (the service's EMBED_TOKEN). Optional if the service runs open. */
  token?: string;
  /** Index namespace for this store — must be unique fleet-wide (e.g. `linn/9f9857cd`). */
  namespace: string;
  /** Per-request timeout. Default 30 s (bulk upserts of long messages can take a while). */
  requestTimeoutMs?: number;
  /** Background sync cadence. Default 60 s. 0 disables background sync (search still catches up). */
  syncIntervalMs?: number;
  /** Items per upsert request. Default 128, max 256 (service limit). */
  syncBatch?: number;
  /**
   * The most items one background tick's pass writes to the index: what the
   * service reports each upsert inserted or updated, with each queued edit
   * counted as one. Deletes aren't counted: a pass sends its queued removals
   * whatever the budget, and deletes the items its summaries had from before
   * they were keyed by creation time as it sends them.
   *
   * A pass also re-sends items the service already holds unchanged. They
   * spend no budget however many there are, and each costs the service a
   * check and a metadata write, with no embedding. They're the overlap
   * behind the message cursor, the summaries since the summary cursor while
   * a delete of their old items keeps failing, and, once on a branch with
   * no cursor yet, as after upgrading to keys with the creation time, the
   * summaries it shares with other branches. A tick that finds a pass
   * already running, such as a search's catch-up, starts none of its own.
   * Default 1024.
   */
  maxSyncPerTick?: number;
  /**
   * The most items a pre-search catch-up writes to the index before
   * searching anyway, counted as for `maxSyncPerTick`. A search that finds a
   * pass already running, such as a tick's, waits for that pass instead,
   * under that pass's own budget. Default 256.
   */
  maxSyncBeforeSearch?: number;
  /** Re-scan window behind the message watermark, ms. Default 10 min. */
  overlapMs?: number;
  /** Include private-prose tool arguments (think/journal/skip_reply/private_note). Default true. */
  includePrivateTools?: boolean;
  /** Per-item text cap in chars (service caps at 200k; model truncates at its max_seq_length). Default 32k. */
  maxChars?: number;
}

export interface IndexItem {
  id: string;
  text: string;
  ts?: number;
  channel?: string | null;
  kind: 'message' | 'summary';
  level?: number;
  cursor?: number;
  meta?: Record<string, unknown>;
}

export interface IndexStats {
  namespace: string;
  model: string;
  dim: number;
  count: number;
  by_kind: Record<string, { count: number; max_ts: number | null; min_ts: number | null; max_cursor: number | null }>;
}

export interface SearchHit {
  id: string;
  score: number;
  ts: number | null;
  channel: string | null;
  kind: string;
  level: number | null;
  meta: Record<string, unknown>;
  /** The text the service sends for the hit, where it keeps text; a service that keeps none leaves it out. */
  text?: string;
  /** The length of the text the service holds for the hit; a service that keeps no text may leave it out too. */
  chars?: number;
}

export interface SearchRequest {
  query: string;
  k?: number;
  ts_from?: number;
  ts_to?: number;
  channel?: string;
  kinds?: string[];
  level?: number;
  min_score?: number;
  snippet?: number;
}

export interface SearchResponse {
  namespace: string;
  hits: SearchHit[];
  count_indexed: number;
  timing_ms: { embed: number; search: number };
}

const PRIVATE_PROSE_TOOLS = new Set(['think', 'journal', 'skip_reply', 'private_note']);

/**
 * The semantic index service's failure, said of the service alone: it didn't
 * answer in time, couldn't be reached, cut its answer off, answered without
 * what its request's caller reads, or answered with an HTTP error. `status` is
 * the answer's HTTP status, and null where no whole answer came. Each caller
 * says what that meant for its own work, a search or the background sync.
 */
export class EmbedServiceError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'EmbedServiceError';
  }
}

/**
 * What stopped a request reaching the service: fetch's cause, such as a
 * refused connection. When several addresses were tried, as for a name like
 * localhost with both an IPv6 and an IPv4 address, the cause is an
 * AggregateError with no message of its own, and each address's error says it.
 */
function unreachedReason(e: unknown): string {
  const cause = (e as { cause?: unknown } | null)?.cause;
  if (cause instanceof AggregateError && !cause.message) {
    const each = cause.errors.map((err) => (err instanceof Error ? err.message : String(err))).filter(Boolean);
    if (each.length > 0) return each.join('; ');
  }
  return (cause instanceof Error && cause.message) || (e instanceof Error ? e.message : String(e));
}

export class SemanticIndexClient {
  private readonly base: string;
  private readonly ns: string;
  private readonly timeoutMs: number;
  constructor(private readonly cfg: SemanticIndexConfig) {
    this.base = cfg.url.replace(/\/+$/, '');
    this.ns = encodeURIComponent(cfg.namespace);
    this.timeoutMs = cfg.requestTimeoutMs ?? 30_000;
  }

  /**
   * A request's answer, as JSON. `expect` is what the caller reads of it: an
   * answer without that, such as a web page at a wrong address, fails as
   * one, with its status, since the service did answer.
   */
  private async call<T>(
    method: 'GET' | 'POST', path: string, body?: unknown, expect?: { what: string; is: (json: unknown) => boolean },
  ): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.token) headers.authorization = `Bearer ${this.cfg.token}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    // The request's kind, for a message: search, upsert, delete or stats.
    const request = path.slice(path.lastIndexOf('/') + 1);
    // The timeout as the client used it: whole seconds, or else milliseconds.
    const within = this.timeoutMs % 1000 === 0 ? `${this.timeoutMs / 1000} s` : `${this.timeoutMs} ms`;
    try {
      let res: Response;
      let text: string;
      let answered = false;
      try {
        res = await fetch(`${this.base}${path}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal,
        });
        answered = true;
        // An answer cut off after its status, or not finished within the
        // timeout, counts as no answer. That's rare, and a stats or delete
        // request that misses its 404 this way is made again on a later pass
        // of the sync.
        text = await res.text();
      } catch (e) {
        throw new EmbedServiceError(
          answered
            ? ctrl.signal.aborted
              ? `the semantic index service's answer to the ${request} request didn't finish within ${within}`
              : `the semantic index service's answer to the ${request} request was cut off (${unreachedReason(e)})`
            : ctrl.signal.aborted
              ? `the semantic index service didn't answer the ${request} request within ${within}`
              : `the semantic index service couldn't be reached for the ${request} request (${unreachedReason(e)})`,
          null,
        );
      }
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = undefined; }
      if (!res.ok) {
        // The service's message, or any other body, is quoted to at most its
        // first 200 UTF-16 units, one fewer rather than end on half of a
        // surrogate pair, and a quote that's cut ends in "…". A message that
        // isn't text quotes the body instead.
        const given = (json as { error?: { message?: unknown } } | undefined)?.error?.message;
        const quoted = typeof given === 'string' ? given : text;
        const cut = safeSlice(quoted, 0, 200);
        const msg = cut.length < quoted.length ? `${cut}…` : cut;
        throw new EmbedServiceError(
          `the semantic index service answered the ${request} request with an error (HTTP ${res.status}${msg ? `: ${msg}` : ''})`,
          res.status,
        );
      }
      if (expect && !expect.is(json)) {
        throw new EmbedServiceError(
          `the semantic index service answered the ${request} request without ${expect.what} (HTTP ${res.status})`,
          res.status,
        );
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stats for this namespace; `null` when the namespace does not exist yet. */
  async stats(): Promise<IndexStats | null> {
    try {
      return await this.call<IndexStats>('GET', `/v1/index/${this.ns}/stats`, undefined, {
        what: 'stats by kind', is: (json) => isObject((json as { by_kind?: unknown } | undefined)?.by_kind),
      });
    } catch (e) {
      if (e instanceof EmbedServiceError && e.status === 404) return null;
      throw e;
    }
  }

  async upsert(items: IndexItem[]): Promise<{ inserted: number; updated: number; unchanged: number; count: number }> {
    return this.call('POST', `/v1/index/${this.ns}/upsert`, { items }, {
      // A pass's budget spends the counts, so an answer without them isn't
      // taken as one.
      what: 'counts of the items inserted and updated', is: (json) => isObject(json)
        && Number.isFinite((json as { inserted?: unknown }).inserted) && Number.isFinite((json as { updated?: unknown }).updated),
    });
  }

  async delete(ids: string[]): Promise<{ deleted: number }> {
    return this.call('POST', `/v1/index/${this.ns}/delete`, { ids });
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    return this.call('POST', `/v1/index/${this.ns}/search`, req, {
      what: 'a list of hits, each with an id', is: (json) => {
        const hits = (json as { hits?: unknown } | undefined)?.hits;
        return Array.isArray(hits) && hits.every(isHit);
      },
    });
  }
}

/** A JSON object: not null, and not a list. */
function isObject(json: unknown): boolean {
  return typeof json === 'object' && json !== null && !Array.isArray(json);
}

/**
 * A hit as semantic_search needs one: an object with a string id, which it
 * reads of every hit. Its ts and meta are read only for the hits it returns,
 * and as far as they can be read.
 */
function isHit(hit: unknown): boolean {
  return isObject(hit) && typeof (hit as { id?: unknown }).id === 'string';
}

/** Text to embed for one message, or '' when there is nothing worth indexing. */
export function messageIndexText(msg: StoredMessage, includePrivateTools = true): string {
  const parts: string[] = [];
  for (const block of msg.content as ContentBlock[]) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (includePrivateTools && block.type === 'tool_use' && PRIVATE_PROSE_TOOLS.has(block.name)) {
      const input = (block as { input?: Record<string, unknown> }).input ?? {};
      for (const v of Object.values(input)) {
        if (typeof v === 'string' && v.trim().length > 0) parts.push(`[${block.name}] ${v}`);
      }
    } else if (block.type === 'tool_use') {
      const said = speechOf(block.name, (block as { input?: unknown }).input);
      if (said) parts.push(`[${said.tool}] ${said.words}`);
    }
  }
  return parts.join('\n').trim();
}

/** Same two metadata shapes HistoryModule's getChannelId reads: MCPL ingestion writes `metadata.channelId`, older paths `metadata.external.channelId`. */
function channelOf(msg: StoredMessage): string | null {
  const md = msg.metadata as { channelId?: unknown; external?: { channelId?: unknown } } | undefined;
  if (typeof md?.channelId === 'string') return md.channelId;
  return typeof md?.external?.channelId === 'string' ? md.external.channelId : null;
}

function authorOf(msg: StoredMessage): string | null {
  const md = msg.metadata as { external?: { authorName?: unknown }; authorName?: unknown } | undefined;
  const a = md?.external?.authorName ?? md?.authorName;
  return typeof a === 'string' ? a : null;
}

export function messageToItem(msg: StoredMessage, cfg: { includePrivateTools?: boolean; maxChars?: number }): IndexItem | null {
  // A stored context injection (stored-injections.ts) is a source's context,
  // such as retrieval's lessons, not something that happened: indexed, it
  // would come back to a search as history.
  if (storedInjectionMarkOf(msg.metadata)) return null;
  const text = messageIndexText(msg, cfg.includePrivateTools ?? true);
  if (!text) return null;
  const tsMs = msg.timestamp.getTime();
  return {
    id: `msg:${String(msg.id)}`,
    text: safeSlice(text, 0, cfg.maxChars ?? 32_000),
    ts: tsMs / 1000,
    channel: channelOf(msg),
    kind: 'message',
    cursor: tsMs,
    meta: { participant: msg.participant, author: authorOf(msg), seq: msg.sequence },
  };
}

export interface SummaryLike {
  id: string;
  level: number;
  content: string;
  tokens: number;
  startMs: number;
  endMs: number;
  firstSequence: number;
  lastSequence: number;
  createdMs: number;
  parentId?: string;
}

/** The text a summary is indexed by: its content trimmed, and cut at `maxChars` at a whole character. */
export function summaryIndexText(s: { content: string }, cfg: { maxChars?: number }): string {
  return safeSlice(s.content.trim(), 0, cfg.maxChars ?? 32_000);
}

/**
 * A summary's index key, `sum:<id>@<created>`. A branch made at an earlier
 * point mints ids its parent already used, so the id alone names two
 * summaries; its creation time, set when it was minted and kept by a branch
 * that inherits it, tells them apart.
 */
export function summaryKey(id: string, createdMs: number): string {
  return `sum:${id}@${createdMs}`;
}

/**
 * A `sum:` key read back: its summary id, and its creation time, or null for
 * a key in the form written before summaries were keyed by it (`sum:<id>`).
 * Null for a key that isn't a summary's. A finite number written as a string
 * reads back as the same number, so the time compares equal to the
 * summary's own.
 */
export function parseSummaryKey(key: string): { id: string; createdMs: number | null } | null {
  if (!key.startsWith('sum:')) return null;
  const rest = key.slice(4);
  const at = rest.lastIndexOf('@');
  if (at > 0 && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/.test(rest.slice(at + 1))) {
    return { id: rest.slice(0, at), createdMs: Number(rest.slice(at + 1)) };
  }
  return rest ? { id: rest, createdMs: null } : null;
}

export function summaryToItem(s: SummaryLike, cfg: { maxChars?: number }): IndexItem | null {
  if (!s.content.trim()) return null;
  return {
    id: summaryKey(s.id, s.createdMs),
    text: summaryIndexText(s, cfg),
    ts: s.startMs / 1000,
    kind: 'summary',
    level: s.level,
    cursor: s.createdMs,
    meta: { endTs: s.endMs / 1000, firstSequence: s.firstSequence, lastSequence: s.lastSequence, tokens: s.tokens, parentId: s.parentId ?? null },
  };
}

/** Edits/removals not yet applied to the index (persisted by the host across restarts). */
export interface PendingChanges { edited: string[]; removed: string[] }

/**
 * A branch's sync cursors for one index: the creation time through which its
 * summaries are sent under their keys, and the time through which its
 * messages are sent. Null where nothing is sent yet.
 */
export interface SyncCursors { namespace: string; summaries: number | null; messages: number | null }

/**
 * Where the sync cursors are kept. HistoryModule keeps them in module state,
 * which the store's branches carry, so a branch made at an earlier point
 * starts from the cursors as they were there, and another branch's passes
 * never move them.
 */
export interface SyncCursorStore {
  read(): SyncCursors | null;
  write(cursors: SyncCursors): void;
}

export interface SyncReport {
  pushed: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /**
   * True when items may be left to send: the pass hit its item cap before
   * the end of the store or of the queued edits, a delete of summaries' old
   * items failed, it failed or was backing off, or the store left the branch
   * it read during it. An edit or removal that a failed send queued again
   * doesn't set it; the next pass sends it.
   */
  more: boolean;
  messagesScanned: number;
  summariesScanned: number;
}

export class SemanticIndexer {
  private inFlight: Promise<SyncReport> | null = null;
  /** The branch each pass read, by its report, for a search that joined it. */
  private readonly passBranch = new WeakMap<SyncReport, string>();
  private consecutiveFailures = 0;
  private backoffUntil = 0;
  lastError: string | null = null;
  lastSyncAt: number | null = null;

  constructor(
    private readonly cm: ContextManager,
    private readonly client: SemanticIndexClient,
    private readonly cfg: SemanticIndexConfig,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** A line for the host's log, naming this indexer's index first, since a host can keep several. */
  warn(line: string): void {
    this.log(`[history/semantic] index ${JSON.stringify(this.cfg.namespace)}: ${line}`);
  }

  /**
   * Edits and removals since the last successful sync. The time-cursor walk
   * only revisits the overlap window, so an edit to an older message (its
   * timestamp does not change) or a removal would otherwise never reach the
   * index. The host persists the pending sets through `onPendingChange` /
   * `restorePending` (HistoryModule keeps them in module state), so edits
   * made during an embed-service outage survive a restart. Events that land
   * while the module is detached are not replayed (removals are still hidden
   * at search time by the current-branch check in HistoryModule).
   */
  private readonly editedIds = new Set<string>();
  private readonly removedIds = new Set<string>();
  private detach: (() => void) | null = null;
  /**
   * Set once the service answers 404 to /delete in a pass whose /stats
   * answered with stats, which shows the index is made, so the 404 means a
   * build without the route. From then on, removals are dropped as they come
   * and no pass calls /delete, until the host restarts or binds the module
   * again, which makes a new indexer. A pass whose /stats answers 404 has no
   * index to remove from and makes no /delete call; a /delete 404 in a pass
   * whose /stats answered with something that isn't stats is re-queued like
   * any other failure, since that answer doesn't show the index is made.
   */
  private deleteUnsupported = false;
  /** Called whenever the pending edit/remove sets change. */
  onPendingChange: ((p: PendingChanges) => void) | null = null;
  /**
   * Where the sync cursors are kept, set by the host. Without one, as
   * before the host wires module state or after it unwires it, this indexer
   * goes on from the cursors it last wrote for each branch, which it keeps
   * in memory. A branch it wrote none for starts with none.
   */
  cursorStore: SyncCursorStore | null = null;
  /** The cursors this indexer last wrote, by branch id ('' for a store without branches). */
  private readonly ownCursors = new Map<string, SyncCursors>();

  /** The store's current branch, by id ('' for a store without branches). */
  branchId(): string {
    return (this.cm as { currentBranch?: () => { id: string } | undefined }).currentBranch?.()?.id ?? '';
  }

  /**
   * The current branch's cursors for this indexer's index. Cursors kept for
   * another namespace, as before the host's index setting changed, are none
   * here.
   */
  private syncCursors(): { summaries: number | null; messages: number | null } {
    const c = this.cursorStore ? this.cursorStore.read() : this.ownCursors.get(this.branchId()) ?? null;
    return c && c.namespace === this.cfg.namespace ? c : { summaries: null, messages: null };
  }

  /** Writes the current branch's cursors, which must be `branch`'s. */
  private setSyncCursors(c: { summaries: number | null; messages: number | null }, branch: string): void {
    const cursors: SyncCursors = { namespace: this.cfg.namespace, summaries: c.summaries, messages: c.messages };
    this.ownCursors.set(branch, cursors);
    this.cursorStore?.write(cursors);
  }

  /**
   * Deletes ids from the index. A 404 in a pass whose /stats answered with
   * stats shows the index is made, so it means a service build without the
   * route: that sets deleteUnsupported and answers the 404's message. Null
   * when the ids are deleted; any other failure throws.
   */
  private async deleteIds(ids: string[], stats: IndexStats | null): Promise<string | null> {
    try {
      await this.client.delete(ids);
      return null;
    } catch (e) {
      if (e instanceof EmbedServiceError && e.status === 404 && stats !== null) {
        this.deleteUnsupported = true;
        return e.message;
      }
      throw e;
    }
  }

  pendingSnapshot(): PendingChanges { return { edited: [...this.editedIds], removed: [...this.removedIds] }; }

  restorePending(p: PendingChanges | null | undefined): void {
    for (const id of p?.removed ?? []) { this.removedIds.add(id); this.editedIds.delete(id); }
    for (const id of p?.edited ?? []) if (!this.removedIds.has(id)) this.editedIds.add(id);
  }

  private pendingChanged(): void { this.onPendingChange?.(this.pendingSnapshot()); }

  /** Subscribe to message-store edits/removals. Idempotent. */
  attach(): void {
    if (this.detach) return;
    const on = (this.cm as { onMessage?: ContextManager['onMessage'] }).onMessage;
    if (typeof on !== 'function') {
      this.warn("the context-manager has no onMessage, so edits and removals won't reach the index");
      return;
    }
    this.detach = on.call(this.cm, (e) => {
      if (e.type === 'edit') { this.editedIds.add(String(e.messageId)); this.pendingChanged(); }
      else if (e.type === 'remove') {
        const id = String(e.messageId); this.editedIds.delete(id);
        if (!this.deleteUnsupported) this.removedIds.add(id);
        this.pendingChanged();
      }
      // removeRange carries only its endpoints; removed ids in it are hidden at search time instead.
    });
  }

  dispose(): void { this.detach?.(); this.detach = null; }

  get backingOff(): boolean { return Date.now() < this.backoffUntil; }

  /** The branch the pass that gave this report read, or null if it read none. */
  passedOn(report: SyncReport): string | null { return this.passBranch.get(report) ?? null; }

  /**
   * Push what the index is missing, writing at most `maxItems` items by the
   * service's own count (edits one each), and stopping where that runs out,
   * inside a millisecond or a message page too.
   * Coalesces: a call while a sync is already running returns that run's
   * promise instead of racing it.
   */
  catchUp(maxItems: number): Promise<SyncReport> {
    if (this.inFlight) return this.inFlight;
    const run = this.runCatchUp(maxItems).finally(() => { this.inFlight = null; });
    this.inFlight = run;
    return run;
  }

  private async runCatchUp(maxItems: number): Promise<SyncReport> {
    const report: SyncReport = { pushed: 0, inserted: 0, updated: 0, unchanged: 0, more: false, messagesScanned: 0, summariesScanned: 0 };
    if (this.backingOff) { report.more = true; return report; }
    const batchSize = Math.min(256, Math.max(1, this.cfg.syncBatch ?? 128));
    // Failures of the edits and removals phase, which don't end the pass, and a
    // stats answer that isn't stats: lastError names each, ended or not.
    const phaseErrors: string[] = [];
    let notStats: EmbedServiceError | null = null;
    try {
      // A 2xx that isn't stats, such as a web page from a wrong route, gives no
      // service watermark, and lastError names the answer. A branch with no
      // message cursor of its own then walks its messages from the beginning,
      // as for a namespace that doesn't exist yet, so a pass whose budget
      // runs out fails on that answer.
      let stats: IndexStats | null = null;
      try {
        stats = await this.client.stats();
      } catch (e) {
        if (!(e instanceof EmbedServiceError && e.status !== null && e.status >= 200 && e.status < 300)) throw e;
        notStats = e;
      }
      // /stats answered 404, which stats() reads as a namespace that doesn't
      // exist: there's no index to remove from.
      const noIndex = stats === null && notStats === null;
      // This branch's cursors, read at each pass so a switch between passes is
      // seen. They're written only when every read this pass made of the
      // store was on the branch read here, so one branch's pass can't move
      // another's cursor past what that branch hasn't sent. A branch with no
      // message cursor starts from the service's watermark, as before cursors
      // were kept per branch, so an upgrade doesn't walk every history again.
      const branch = this.branchId();
      this.passBranch.set(report, branch);
      // Set when a read of the store finds it on another branch.
      let strayed = false;
      // Set when a delete of summaries' old items fails.
      let oldItemsOwed = false;
      const reading = (): void => { if (this.branchId() !== branch) strayed = true; };
      let kept = this.syncCursors();
      // A namespace that doesn't exist holds nothing of this branch's, as after
      // an index is deleted, so the cursors start over, at once, so a pass
      // that fails partway through sending everything again still finds them
      // over.
      if (noIndex && (kept.summaries !== null || kept.messages !== null)) {
        kept = { summaries: null, messages: null };
        this.setSyncCursors(kept, branch);
      }
      // A branch's cursor is its own while the index holds what it sent, and
      // the index's when it doesn't. Every branch's items are in the one
      // index, so an index whose newest item of a kind is older than the
      // cursor may have lost what this branch sent, as a restore from an
      // older backup leaves it, and the pass walks from the index's newest,
      // as the service's watermark did before cursors were kept. Nothing is
      // lost when the newest the branch walked had nothing to index, such as
      // a summary that's blank once trimmed, or was removed since, and then
      // the pass re-sends what lies between, which the service finds
      // unchanged. A kind the stats don't list has no items left.
      const held = (cursor: number | null, kind: string): number | null => {
        if (cursor === null || stats === null) return cursor;
        const newest = stats.by_kind[kind]?.max_cursor ?? null;
        return newest === null ? null : Math.min(cursor, newest);
      };
      const sumCursor = held(kept.summaries, 'summary');
      const msgWm = held(kept.messages, 'message') ?? stats?.by_kind.message?.max_cursor ?? null;
      let sumNext = sumCursor;
      let msgThrough: number | null = null;
      // What the pass may still write. Edits spend one each; summaries and
      // messages spend what the service says each upsert wrote (inserted or
      // updated), so a re-send it finds unchanged, such as the overlap's
      // behind the message cursor, spends no budget and can't freeze a pass.
      // A budget of 1.5 writes one item. One that isn't a number is no limit,
      // as it was before the budget counted writes, and chunks stay a batch.
      const floored = Math.floor(maxItems);
      let budget = Number.isNaN(floored) ? Infinity : floored;
      let pending: IndexItem[] = [];
      const flush = async (): Promise<void> => {
        if (pending.length === 0) return;
        const r = await this.client.upsert(pending);
        report.pushed += pending.length; report.inserted += r.inserted; report.updated += r.updated; report.unchanged += r.unchanged;
        budget -= r.inserted + r.updated;
        pending = [];
      };
      /** Pending items are sent once they could write all the budget left,
       *  so a pass never writes more than its budget. */
      const full = (): boolean => pending.length >= Math.min(batchSize, budget);

      // Edits and removals first: they never come back round in the time walk.
      // This phase fails on its own: a failure re-queues its ids, is logged
      // and reported via lastError, and the tick falls through to summaries
      // and the time walk, so one bad delete/upsert cannot freeze indexing.
      if (this.removedIds.size > 0 || this.editedIds.size > 0) {
        const removed = [...this.removedIds];
        // Edits spend the budget like any other upsert, so a large queue left
        // by an outage cannot make a search's bounded catch-up unbounded; the
        // rest stay queued for the next pass.
        // An edit whose message is on the branch spends it, one edited down to
        // nothing indexable too, even in a pass that makes no /delete call; one
        // whose message left the branch is dropped for free.
        this.removedIds.clear();
        const edited: string[] = [];
        const toDelete = removed.map((id) => `msg:${id}`);
        const blanked: string[] = [];
        const toUpsert: IndexItem[] = [];
        for (const id of [...this.editedIds]) {
          if (budget <= 0) break;
          this.editedIds.delete(id);
          const m = this.cm.getMessage(id as never);
          // Not on the current branch (e.g. /undo after the edit): drop it,
          // never delete — /redo brings the message back and the time walk
          // will not revisit it. Search-time branch checks hide it meanwhile.
          if (!m) continue;
          edited.push(id); budget--;
          const item = messageToItem(m, this.cfg);
          // On the branch but edited down to nothing indexable: delete.
          if (item) toUpsert.push(item); else { toDelete.push(`msg:${id}`); blanked.push(id); }
        }
        if (this.editedIds.size > 0) report.more = true;
        // The removals and blanked edits are dropped with no /delete call in
        // two cases. With no index (/stats answered 404), there's nothing to
        // remove, and the index this pass makes takes only what the store
        // holds and can index, which leaves them out. Once the service is known
        // to lack the route (deleteUnsupported), the index keeps them, and
        // search-time checks (on-branch, still indexable) keep them out of
        // results.
        if (toDelete.length > 0 && !noIndex && !this.deleteUnsupported) {
          // What the delete held, by kind, for a warning.
          const what = [
            removed.length > 0 ? `${removed.length} removal(s)` : null,
            blanked.length > 0 ? `${blanked.length} edit(s) down to nothing indexable` : null,
          ].filter((s): s is string => s !== null).join(' and ');
          try {
            const missing = await this.deleteIds(toDelete, stats);
            if (missing !== null) {
              this.warn(
                `/delete answered 404, so the service lacks that route; dropping ${what}. Later removals and edits `
                  + `down to nothing indexable are dropped too, until the host restarts or binds the history module `
                  + `again: ${missing}`,
              );
            }
          } catch (e) {
            // Any other failure, and a 404 in a pass whose /stats answered
            // with something that isn't stats, which doesn't show the index
            // is made: re-queued, for a later pass.
            const msg = e instanceof Error ? e.message : String(e);
            for (const id of removed) this.removedIds.add(id);
            for (const id of blanked) if (!this.removedIds.has(id)) this.editedIds.add(id);
            phaseErrors.push(msg);
            this.warn(`delete failed, ${what} re-queued: ${msg}`);
          }
        }
        try {
          for (let i = 0; i < toUpsert.length; i += batchSize) {
            const chunk = toUpsert.slice(i, i + batchSize);
            const r = await this.client.upsert(chunk);
            report.pushed += chunk.length; report.inserted += r.inserted; report.updated += r.updated; report.unchanged += r.unchanged;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          for (const id of edited) if (!this.removedIds.has(id)) this.editedIds.add(id);
          phaseErrors.push(msg);
          this.warn(`edit re-upsert failed, ${edited.length} edit(s) re-queued: ${msg}`);
        }
        this.pendingChanged();
      }

      // Summaries before messages: they are few, and a message backlog that
      // exceeds every tick's budget must not keep new summaries out forever.
      {
        const cursor = sumCursor;
        reading();
        const all = this.cm.getSummariesInRange({ fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }) as SummaryLike[];
        report.summariesScanned = all.length;
        // `>=`: a summary minted in the cursor's millisecond after the pass
        // that wrote it read the store is sent by the next one. Re-sending
        // the others there is a dedup no-op for the service and costs no
        // budget.
        const fresh = all.filter((s) => cursor === null || s.createdMs >= cursor).sort((a, b) => a.createdMs - b.createdMs);
        // Through which creation time this pass sent every summary it read.
        // A pass whose budget runs out inside a millisecond leaves the cursor
        // at the one before, so the next pass sends the rest of that
        // millisecond, re-sending what this one wrote of it at no cost, and
        // counts all of it as new for the old keys below.
        let through: number | null = null;
        // The millisecond of the summaries being sent.
        let at: number | null = null;
        let finished = true;
        // Each newly sent summary's key in the form written before keys
        // carried the creation time, for deleting once its new item is in.
        const oldKeys: string[] = [];
        for (const s of fresh) {
          if (s.createdMs !== at) { through = at; at = s.createdMs; }
          if (budget <= 0) { report.more = true; finished = false; break; }
          const item = summaryToItem(s, this.cfg);
          if (!item) continue;
          pending.push(item);
          if (cursor === null || s.createdMs > cursor) oldKeys.push(`sum:${s.id}`);
          if (full()) await flush();
        }
        await flush();
        if (finished) through = at;
        // The index's old items go once their summaries' new ones are in, a
        // batch of ids to a request. On a service without /delete they stay,
        // and search leaves them out. A failed delete leaves the cursor, so
        // the next pass sends those summaries again, which the service finds
        // unchanged, and deletes again.
        let deleted = true;
        if (oldKeys.length > 0 && !noIndex && !this.deleteUnsupported) {
          try {
            let missing: string | null = null;
            for (let i = 0; i < oldKeys.length && missing === null; i += batchSize) {
              missing = await this.deleteIds(oldKeys.slice(i, i + batchSize), stats);
            }
            if (missing !== null) {
              this.warn(
                `/delete answered 404, so the service lacks that route; any items these ${oldKeys.length} summaries had `
                  + `from before keys carried the creation time stay, and search leaves them out. Later removals and edits `
                  + `down to nothing indexable are dropped too, until the host restarts or binds the history module `
                  + `again: ${missing}`,
              );
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            deleted = false;
            oldItemsOwed = true;
            phaseErrors.push(msg);
            this.warn(`deleting ${oldKeys.length} summaries' items from before they were keyed by creation time failed; the next pass tries again: ${msg}`);
          }
        }
        if (deleted && through !== null) sumNext = through;
      }

      // Messages: walk forward from (watermark - overlap) via the time index.
      // Sound because rows are stamped at append time (CM addMessage takes no
      // timestamp). An importer that writes historical stamps into a live
      // store, or a backward clock step past the overlap, lands behind the
      // watermark and is never indexed.
      let fromMs = msgWm === null ? undefined : Math.max(0, msgWm - (this.cfg.overlapMs ?? 600_000));
      // Messages at exactly `fromMs` already seen this pass. The query bounds
      // are inclusive, so the next page starts at the last page's final
      // millisecond and skips the ones already walked with `offset` — a run
      // of more than a page within one millisecond is walked, not jumped.
      let offset = 0;
      const pageSize = 256;
      // The walk starts with the overlap's re-sends, which spend no budget, but
      // like every chunk go out no bigger than the budget left, so a pass
      // whose summaries left little sends them a few at a time.
      for (let stopped = false; !stopped;) {
        if (budget <= 0) { report.more = true; break; }
        reading();
        const page = this.cm.queryMessagesByTime({ fromMs, offset, limit: pageSize });
        const msgs = page.messages;
        report.messagesScanned += msgs.length;
        for (const m of msgs) {
          // Only what the service writes spends the budget (flush). The
          // overlap re-walk behind the watermark is a dedup no-op for the
          // service, and it must be one for the budget too: when the overlap
          // window held more messages than a tick's budget, every tick spent
          // it all re-sending the same indexed items and never reached the
          // first new one — the index froze at the watermark while reporting
          // merely `more: true`. A pass stops inside a page once the budget
          // is spent; the next one's overlap sends the rest of the
          // millisecond it stopped in.
          if (budget <= 0) { report.more = true; stopped = true; break; }
          const item = messageToItem(m, this.cfg);
          if (!item) continue;
          pending.push(item);
          if (item.cursor !== undefined && (msgThrough === null || item.cursor > msgThrough)) msgThrough = item.cursor;
          if (full()) await flush();
        }
        if (stopped || msgs.length < pageSize) break;
        const lastMs = msgs[msgs.length - 1]!.timestamp.getTime();
        const atLast = msgs.filter((m) => m.timestamp.getTime() === lastMs).length;
        offset = lastMs === fromMs ? offset + atLast : atLast;
        fromMs = lastMs;
      }
      await flush();
      // Every send of this pass is in, so its cursors stand, unless the store
      // left the branch the pass read during it: what it read may then be
      // another branch's. A pass that moves neither cursor writes no state.
      const msgNext = msgThrough ?? msgWm;
      const left = strayed || this.branchId() !== branch;
      if ((sumNext !== kept.summaries || msgNext !== kept.messages) && !left) {
        this.setSyncCursors({ summaries: sumNext, messages: msgNext }, branch);
      }
      if (notStats && report.more) throw notStats;
      // The current branch may then have items this pass didn't send, and
      // old items a failed delete left are still to go.
      if (left || oldItemsOwed) report.more = true;
      this.consecutiveFailures = 0; this.lastError = named(notStats?.message ?? null, ...phaseErrors); this.lastSyncAt = Date.now();
      return report;
    } catch (e) {
      this.consecutiveFailures++;
      const delay = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(8, this.consecutiveFailures - 1));
      this.backoffUntil = Date.now() + delay;
      const failure = e instanceof Error ? e.message : String(e);
      this.lastError = named(failure, notStats?.message ?? null, ...phaseErrors);
      this.warn(`sync failed (${this.consecutiveFailures}×, retry in ${Math.round(delay / 1000)}s): ${failure}`);
      report.more = true;
      return report;
    }
  }
}

/** Each failure a sync pass met, once, in the order given, for its lastError: null if none. */
function named(...failures: (string | null)[]): string | null {
  return [...new Set(failures.filter((f): f is string => f !== null))].join('; ') || null;
}

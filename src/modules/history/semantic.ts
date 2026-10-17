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
 *    its creation time is the only monotonic signal).
 *
 * What gets embedded per message: text blocks verbatim, plus the string
 * arguments of the agent's private-prose tools (think / journal / skip_reply
 * / private_note) labelled `[think] …` — that is the resident's own diary and
 * is exactly what "what did I think about X" should find. tool_result
 * payloads, other tool arguments, thinking blocks and media are skipped.
 *
 * Failure posture: the service being down never breaks the module. Sync ticks
 * log and back off; `semantic_search` returns a clean tool error.
 */

import type { ContextManager, StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { safeSlice } from '../../safe-slice.js';

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
  /** Max items one background tick will push. Default 1024. */
  maxSyncPerTick?: number;
  /** Max items a pre-search catch-up will push before searching anyway. Default 256. */
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
  text?: string;
  chars: number;
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
    return this.call('POST', `/v1/index/${this.ns}/upsert`, { items }, { what: 'a JSON object', is: isObject });
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
  const text = messageIndexText(msg, cfg.includePrivateTools ?? true);
  if (!text) return null;
  const tsMs = msg.timestamp.getTime();
  return {
    id: `msg:${String(msg.id)}`,
    text: text.slice(0, cfg.maxChars ?? 32_000),
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

export function summaryToItem(s: SummaryLike, cfg: { maxChars?: number }): IndexItem | null {
  const text = s.content.trim();
  if (!text) return null;
  return {
    id: `sum:${s.id}`,
    text: text.slice(0, cfg.maxChars ?? 32_000),
    ts: s.startMs / 1000,
    kind: 'summary',
    level: s.level,
    cursor: s.createdMs,
    meta: { endTs: s.endMs / 1000, firstSequence: s.firstSequence, lastSequence: s.lastSequence, tokens: s.tokens, parentId: s.parentId ?? null },
  };
}

/** Edits/removals not yet applied to the index (persisted by the host across restarts). */
export interface PendingChanges { edited: string[]; removed: string[] }

export interface SyncReport {
  pushed: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** True when the tick hit its item cap before reaching the end of the store. */
  more: boolean;
  messagesScanned: number;
  summariesScanned: number;
}

export class SemanticIndexer {
  private inFlight: Promise<SyncReport> | null = null;
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
   * Set once the service answers 404 to /delete (a build without the route, or
   * a store whose index doesn't exist yet): removals are dropped from then on,
   * until the host restarts or binds the module again, which makes a new indexer.
   */
  private deleteUnsupported = false;
  /** Called whenever the pending edit/remove sets change. */
  onPendingChange: ((p: PendingChanges) => void) | null = null;

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

  /**
   * Push what the index is missing, up to `maxItems`. Coalesces: a call while
   * a sync is already running returns that run's promise instead of racing it.
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
      // watermark: the pass walks from the start, as for a namespace that
      // doesn't exist yet, and lastError names the answer. Every pass then
      // starts over, and a history longer than a pass's budget is never
      // walked to its end, so a pass whose budget runs out fails on that
      // answer.
      let stats: IndexStats | null = null;
      try {
        stats = await this.client.stats();
      } catch (e) {
        if (!(e instanceof EmbedServiceError && e.status !== null && e.status >= 200 && e.status < 300)) throw e;
        notStats = e;
      }
      const msgWm = stats?.by_kind.message?.max_cursor ?? null;
      const sumWm = stats?.by_kind.summary?.max_cursor ?? null;
      let budget = maxItems;
      let pending: IndexItem[] = [];
      const flush = async (): Promise<void> => {
        if (pending.length === 0) return;
        const r = await this.client.upsert(pending);
        report.pushed += pending.length; report.inserted += r.inserted; report.updated += r.updated; report.unchanged += r.unchanged;
        pending = [];
      };

      // Edits and removals first: they never come back round in the time walk.
      // This phase fails on its own: a failure re-queues its ids, is logged
      // and reported via lastError, and the tick falls through to summaries
      // and the time walk, so one bad delete/upsert cannot freeze indexing.
      if (this.removedIds.size > 0 || this.editedIds.size > 0) {
        const removed = [...this.removedIds];
        // Edits spend the budget like any other upsert, so a large queue left
        // by an outage cannot make a search's bounded catch-up unbounded; the
        // rest stay queued for the next pass.
        // Only actionable edits (an upsert or a delete) spend it: one whose
        // message left the branch is dropped for free.
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
        if (toDelete.length > 0) {
          try {
            await this.client.delete(toDelete);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (e instanceof EmbedServiceError && e.status === 404) {
              // A service build without /delete (or a namespace that does
              // not exist). Drop the removals and blanked edits: search-time
              // checks (on-branch, still indexable) keep them out of results.
              this.deleteUnsupported = true;
              this.warn(
                "/delete answered 404, so the service lacks that route or this index isn't made yet; "
                  + `dropping ${toDelete.length} removal(s), and every later one until the host restarts or binds the `
                  + `history module again: ${msg}`,
              );
            } else {
              for (const id of removed) this.removedIds.add(id);
              for (const id of blanked) if (!this.removedIds.has(id)) this.editedIds.add(id);
              phaseErrors.push(msg);
              this.warn(`delete failed, ${removed.length} removal(s) re-queued: ${msg}`);
            }
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
        const all = this.cm.getSummariesInRange({ fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }) as SummaryLike[];
        report.summariesScanned = all.length;
        // `>=`: summaries sharing the watermark's millisecond may be only
        // partly indexed (a bounded pass can stop inside a tie). Re-sending
        // them is a dedup no-op for the service and costs no budget.
        const fresh = all.filter((s) => sumWm === null || s.createdMs >= sumWm).sort((a, b) => a.createdMs - b.createdMs);
        for (const s of fresh) {
          if (budget <= 0) { report.more = true; break; }
          const item = summaryToItem(s, this.cfg);
          if (!item) continue;
          pending.push(item);
          if (sumWm === null || s.createdMs > sumWm) budget--;
          if (pending.length >= batchSize) await flush();
        }
        await flush();
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
      for (;;) {
        if (budget <= 0) { report.more = true; break; }
        const page = this.cm.queryMessagesByTime({ fromMs, offset, limit: pageSize });
        const msgs = page.messages;
        report.messagesScanned += msgs.length;
        for (const m of msgs) {
          const item = messageToItem(m, this.cfg);
          if (!item) continue;
          pending.push(item);
          // Only NEW items spend the budget. The overlap re-walk behind the
          // watermark is a dedup no-op for the service, and it must be one
          // for the budget too: when the overlap window held more messages
          // than a tick's budget, every tick spent it all re-sending the same
          // indexed items and never reached the first new one — the index
          // froze at the watermark while reporting merely `more: true`.
          if (msgWm === null || item.cursor === undefined || item.cursor > msgWm) budget--;
          if (pending.length >= batchSize) await flush();
        }
        if (msgs.length < pageSize) break;
        const lastMs = msgs[msgs.length - 1]!.timestamp.getTime();
        const atLast = msgs.filter((m) => m.timestamp.getTime() === lastMs).length;
        offset = lastMs === fromMs ? offset + atLast : atLast;
        fromMs = lastMs;
      }
      await flush();
      if (notStats && report.more) throw notStats;
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

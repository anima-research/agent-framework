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

export class SemanticIndexClient {
  private readonly base: string;
  private readonly ns: string;
  private readonly timeoutMs: number;
  constructor(private readonly cfg: SemanticIndexConfig) {
    this.base = cfg.url.replace(/\/+$/, '');
    this.ns = encodeURIComponent(cfg.namespace);
    this.timeoutMs = cfg.requestTimeoutMs ?? 30_000;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.token) headers.authorization = `Bearer ${this.cfg.token}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal,
      });
      const text = await res.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = undefined; }
      if (!res.ok) {
        const msg = (json as { error?: { message?: string } } | undefined)?.error?.message ?? text.slice(0, 200);
        throw new Error(`embed-service ${method} ${path} → ${res.status}: ${msg}`);
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stats for this namespace; `null` when the namespace does not exist yet. */
  async stats(): Promise<IndexStats | null> {
    try {
      return await this.call<IndexStats>('GET', `/v1/index/${this.ns}/stats`);
    } catch (e) {
      if (e instanceof Error && /→ 404/.test(e.message)) return null;
      throw e;
    }
  }

  async upsert(items: IndexItem[]): Promise<{ inserted: number; updated: number; unchanged: number; count: number }> {
    return this.call('POST', `/v1/index/${this.ns}/upsert`, { items });
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    return this.call<SearchResponse>('POST', `/v1/index/${this.ns}/search`, req);
  }
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
        if (typeof v === 'string' && v.trim().length > 20) parts.push(`[${block.name}] ${v}`);
      }
    }
  }
  return parts.join('\n').trim();
}

function channelOf(msg: StoredMessage): string | null {
  const ext = (msg.metadata as { external?: { channelId?: unknown } } | undefined)?.external;
  return typeof ext?.channelId === 'string' ? ext.channelId : null;
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
    try {
      const stats = await this.client.stats();
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

      // Messages: walk forward from (watermark - overlap) via the time index.
      let fromMs = msgWm === null ? undefined : Math.max(0, msgWm - (this.cfg.overlapMs ?? 600_000));
      const pageSize = 256;
      for (;;) {
        if (budget <= 0) { report.more = true; break; }
        const page = this.cm.queryMessagesByTime({ fromMs, limit: pageSize });
        const msgs = page.messages;
        report.messagesScanned += msgs.length;
        for (const m of msgs) {
          const item = messageToItem(m, this.cfg);
          if (!item) continue;
          pending.push(item); budget--;
          if (pending.length >= batchSize) await flush();
        }
        if (msgs.length < pageSize) break;
        const lastMs = msgs[msgs.length - 1]!.timestamp.getTime();
        // Advance strictly: if a whole page shares one millisecond we would spin — step past it.
        fromMs = lastMs === fromMs ? lastMs + 1 : lastMs;
      }
      await flush();

      // Summaries: everything created after the summary watermark, any level.
      if (!report.more) {
        const all = this.cm.getSummariesInRange({ fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }) as SummaryLike[];
        report.summariesScanned = all.length;
        const fresh = all.filter((s) => sumWm === null || s.createdMs > sumWm).sort((a, b) => a.createdMs - b.createdMs);
        for (const s of fresh) {
          if (budget <= 0) { report.more = true; break; }
          const item = summaryToItem(s, this.cfg);
          if (!item) continue;
          pending.push(item); budget--;
          if (pending.length >= batchSize) await flush();
        }
        await flush();
      }
      this.consecutiveFailures = 0; this.lastError = null; this.lastSyncAt = Date.now();
      return report;
    } catch (e) {
      this.consecutiveFailures++;
      const delay = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(8, this.consecutiveFailures - 1));
      this.backoffUntil = Date.now() + delay;
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log(`[history/semantic] sync failed (${this.consecutiveFailures}×, retry in ${Math.round(delay / 1000)}s): ${this.lastError}`);
      report.more = true;
      return report;
    }
  }
}

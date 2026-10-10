/**
 * HistoryModule — read-only access to an agent's full uncompressed message
 * history, backed by context-manager's native chronicle secondary index
 * (`queryMessagesByTime` / `queryMessagesByChannel` /
 * `queryMessagesByTimeAndChannel` / `getChannelMessageCounts` /
 * `getChannelTokenStats`, @animalabs/context-manager >= 0.6.0). Those calls
 * are O(log n + k) against chronicle's `/timestamp` and
 * `/metadata/external/channelId` field indexes, not a full-store scan, so
 * this module can answer "what happened in #foo last Tuesday" against a
 * multi-million-message store without walking the whole log.
 *
 * Four tools:
 *  - `stats`    — per-channel message counts (all-time) + token totals
 *                 (range-scoped), for orienting before pulling raw content.
 *  - `extract`  — paginated raw messages for a time range and/or channel.
 *  - `search`   — substring/regex match over a narrowed candidate window,
 *                 with an explicit truncation signal when the caller's
 *                 filter was too broad for `maxScan`.
 *  - `overview` — a compression-summary table of contents (zero new LLM
 *                 calls) for a time range, gap-filled with raw message
 *                 counts wherever nothing has been summarized yet. See
 *                 `handleOverview` for the fold-reduction and gap-fill
 *                 algorithm.
 *
 * All four accept `channelId` as either a channel label (e.g. `#general`)
 * or a raw internal channel id — `resolveChannel()` resolves a label via
 * the bound `ChannelRegistry`'s durable label history before it reaches any
 * context-manager call. A host that hasn't wired up MCPL (no registry
 * bound) sees unchanged behavior: `channelId` is treated as already the raw
 * internal id.
 *
 * Kept deliberately read-only, same posture as HealthModule: no side
 * effects, no message mutation. `onProcess` is a no-op.
 *
 * Every query dispatch collapses onto `queryMessagesByTimeAndChannel` — its
 * own implementation already handles "only a time range", "only a channel",
 * or "neither" by delegating to the single-filter native queries (see
 * context-manager's `test/message-store-history-index.test.ts`), so this
 * module doesn't need to re-decide which of the three query methods to call.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ContextManager, StoredMessage, ChannelCount, ChannelTokenStats, TimeRangeSummaryEntry } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import type { Module, ModuleContext } from '../../types/module.js';
import type { ToolDefinition, ToolCall, ToolResult, ProcessEvent } from '../../types/events.js';
import type { EventResponse, ProcessState } from '../../types/module.js';
import type { SearchWorkerMessage, SearchWorkerMatch } from './search-regex-worker.js';
import type { ChannelRegistry } from '../../mcpl/channel-registry.js';
import { SemanticIndexClient, SemanticIndexer, messageIndexText, type SemanticIndexConfig, type SyncReport, type PendingChanges } from './semantic.js';
import { FOLDS_TOOL, handleFolds, type FoldsInput } from './folds.js';

// ============================================================================
// Tool input shapes
// ============================================================================

interface StatsInput {
  from?: string;
  to?: string;
  channelId?: string;
}

/** One author spec or several — see `matchesAuthorFilter`. */
type AuthorSpec = string | string[];

interface ExtractInput {
  from?: string;
  to?: string;
  channelId?: string;
  limit?: number;
  offset?: number;
  format?: 'text' | 'raw';
  author?: AuthorSpec;
  excludeAuthor?: AuthorSpec;
  maxScan?: number;
  /** Resume point of an author-filtered scan (from a previous `resume`). */
  windowOffset?: number;
  /** Id of the message just before `windowOffset` (from a previous `resume`). */
  afterId?: string | null;
  /** Time-ordered (no channelId) resume only: the store's highest sequence when the previous call ran. */
  seqMark?: number;
  aroundId?: string;
  before?: number;
  after?: number;
  allChannels?: boolean;
}

interface SearchInput {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  from?: string;
  to?: string;
  channelId?: string;
  author?: AuthorSpec;
  excludeAuthor?: AuthorSpec;
  order?: 'oldest' | 'newest';
  /** Continuation only (from a previous `resume`): messages at exactly the
   *  resume bound's millisecond whose sequence lies in [lo, hi] were already
   *  scanned. A range, not a count, so a message added or removed at that
   *  millisecond between calls can't shift what gets skipped. */
  skipSequences?: [number, number];
  limit?: number;
  maxScan?: number;
}

interface OverviewInput {
  from?: string;
  to?: string;
  channelId?: string;
  level?: number;
  limit?: number;
}

interface SemanticSearchInput {
  query: string;
  limit?: number;
  from?: string;
  to?: string;
  channelId?: string;
  kinds?: 'messages' | 'summaries' | 'both';
  level?: number;
  minScore?: number;
}

export interface HistoryModuleOptions {
  /** Enable `semantic_search` against a shared embed-service (see ./semantic.ts). Absent = tool not offered. */
  semantic?: SemanticIndexConfig;
}

// ============================================================================
// Limits
// ============================================================================

const EXTRACT_DEFAULT_LIMIT = 50;
const EXTRACT_MAX_LIMIT = 200;

/**
 * Real ceiling of the native chronicle pagination `offset` argument (a u32
 * at the N-API boundary). `Number.MAX_SAFE_INTEGER` is NOT a safe ceiling
 * for this field: a value between 0xFFFFFFFF and MAX_SAFE_INTEGER passes a
 * naive upper-bound check unchanged, then wraps/truncates when it crosses
 * into an unsigned 32-bit int on the native side — silently wrong
 * pagination (repro: offset:4294967296 against a real store "succeeded"
 * and returned page 0) instead of a clean failure. Clamping to this ceiling
 * (same clamp-not-reject behavior `limit` already has) means anything
 * beyond it lands on an offset no real store's message count will ever
 * reach, i.e. a correctly-empty page, rather than wrapping onto a wrong one.
 */
const NATIVE_OFFSET_MAX = 0xffffffff; // 4294967295

/**
 * `extract` with an author filter can't lean on a native index (chronicle
 * indexes time and channel, not author), so it pages through the time/channel
 * window and filters in-process. Bounded like `search`'s maxScan, with the
 * same explicit truncated/scannedThrough signal when the window is larger.
 */
const EXTRACT_FILTER_DEFAULT_MAX_SCAN = 10000;
const EXTRACT_FILTER_MAX_MAX_SCAN = 50000;
/** How far (in window positions) a filtered-extract resume looks for its
 *  `afterId` when the window moved since the previous call. */
const RELOCATE_RADIUS = 1000;
/** Most appends a no-channel resume walks back through to check for
 *  messages added behind its cursor; past it the check is reported as
 *  unverified rather than failing. */
const APPENDED_SCAN_CAP = 200_000;
/** Native page size for the in-process filtered scans above. */
const FILTER_SCAN_PAGE = 1000;

/** `extract({aroundId})` window sizes, per side. */
const AROUND_DEFAULT = 10;
const AROUND_MAX = 100;
/** Upper bound on messages sharing the anchor's millisecond that
 *  `extract({aroundId})` will fetch to order them by sequence — real stores
 *  see a handful; past this the call fails loudly rather than guessing. */
const AROUND_TIE_CAP = 5000;

function tieCapError(anchorId: string, n: number): Error {
  return new Error(
    `Message ${anchorId} shares its timestamp with ${n} messages (more than ${AROUND_TIE_CAP}), too many to order ` +
      'around it. Use extract with from/to set to that instant instead.',
  );
}

/** Largest valid Date value (ms) — an open newest edge. */
const MAX_DATE_MS = 8.64e15;

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
const SEARCH_DEFAULT_MAX_SCAN = 5000;
const SEARCH_MAX_MAX_SCAN = 50000;

/**
 * `overview` response entry cap — unlike `stats`/`extract`/`search`, which
 * all clamp their result sizes, `overview` had none: an unbounded call
 * against a long-lived resident with thousands of minted summaries would
 * return every overlapping summary's full `content` text inlined, with one
 * `getChannelTokenStats` native call per entry, synchronously, with no
 * limit — exactly the resource this tool exists to conserve. Default/max
 * roughly match `extract`'s own scale.
 */
const OVERVIEW_DEFAULT_LIMIT = 50;
const OVERVIEW_MAX_LIMIT = 200;

const SEMANTIC_DEFAULT_LIMIT = 10;
const SEMANTIC_MAX_LIMIT = 50;
/** Largest k sent to the embed-service when over-fetching past dropped hits (its own cap is 200). */
const SEMANTIC_MAX_FETCH = 200;
/** Local snippet: the leading SEMANTIC_SNIPPET_CHARS of the current text. */
function snippetOf(text: string): string {
  return text.length <= SEMANTIC_SNIPPET_CHARS ? text : `${text.slice(0, SEMANTIC_SNIPPET_CHARS)}…`;
}
const SEMANTIC_SNIPPET_CHARS = 400;

/**
 * A `<@id>`/`<@!id>` Discord-style mention — same shape `ChannelRegistry`
 * uses for its own DM mention-form matching. A string matching this can
 * never legitimately BE a raw internal channelId (unlike a bare word,
 * which an agent could plausibly be echoing back), so `resolveChannel`
 * treats an unresolved mention the same as an unresolved `#`/`@` label:
 * a clean error, not a silent empty-result passthrough.
 */
const DM_MENTION_RE = /^<@!?\d+>$/;

/** Characters of surrounding context kept on each side of a search snippet. */
const SNIPPET_CONTEXT_CHARS = 80;
/** Fallback snippet length when a match position isn't meaningful to center on. */
const SNIPPET_FALLBACK_CHARS = 160;

/**
 * Wall-clock deadline for a single regex-mode search call, enforced by
 * forcibly terminating the worker thread doing the matching (see
 * search-regex-worker.ts's header for why a worker — not a
 * Promise.race/setTimeout — is required to actually interrupt a stuck
 * synchronous RegExp.exec()). Generous enough for any legitimate pattern
 * against a few thousand short strings; short enough that a catastrophic
 * pattern doesn't tie up a worker (or an agent's turn) for long.
 */
const SEARCH_REGEX_TIMEOUT_MS = 2000;

/** Compiled sibling of search-regex-worker.ts — resolved at runtime the same
 *  way gate-script.ts locates gate-script-worker.js, so it tracks whatever
 *  directory this module's own compiled output lives in. */
const SEARCH_WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'search-regex-worker.js');

// Declared as an array (tool-schema dialects vary on anyOf); a bare string is
// also accepted at runtime — see toAuthorSet.
const AUTHOR_SPEC_JSON_SCHEMA = { type: 'array', items: { type: 'string' } };
const AUTHOR_SCHEMA = {
  ...AUTHOR_SPEC_JSON_SCHEMA,
  description:
    'Only messages written by one of these authors (an array of names or ids). Matches, case-insensitively and exactly, ' +
    'the author\'s display name or user id (a leading "@" or a <@id> mention is accepted), or the ' +
    'stored participant for messages without author metadata — e.g. your own turns, under your name.',
};
const EXCLUDE_AUTHOR_SCHEMA = {
  ...AUTHOR_SPEC_JSON_SCHEMA,
  description: 'Drop messages written by any of these authors (an array of names or ids). Same matching as `author`.',
};

export class HistoryModule implements Module {
  readonly name = 'history';

  private ctx: ModuleContext | null = null;
  private cm: ContextManager | null = null;
  /** The host's fold-export status, shown by history--folds (setFoldExportStatus). */
  private foldExportStatus: (() => unknown) | undefined;
  private channelRegistry: ChannelRegistry | null = null;
  private readonly semanticCfg: SemanticIndexConfig | null;
  private semanticClient: SemanticIndexClient | null = null;
  private indexer: SemanticIndexer | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private firstSyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: HistoryModuleOptions = {}) {
    this.semanticCfg = options.semantic ?? null;
    if (this.semanticCfg) this.semanticClient = new SemanticIndexClient(this.semanticCfg);
  }

  /**
   * Wire the context-manager instance, and optionally the host's
   * ChannelRegistry. Host calls this after ContextManager.open() so the
   * module can issue the native index-backed queries — ModuleContext itself
   * exposes no store/context-manager reference, only the narrower message
   * CRUD surface (addMessage/getMessage/queryMessages), which can't do
   * range or channel queries.
   *
   * `channelRegistry` is optional: a host without MCPL wired up has no
   * registry to pass, and `resolveChannel()` falls back to treating
   * `channelId` as already the raw internal id — today's behavior,
   * unchanged.
   */
  bind(contextManager: ContextManager, channelRegistry?: ChannelRegistry): void {
    this.cm = contextManager;
    this.channelRegistry = channelRegistry ?? null;
    if (this.semanticCfg && this.semanticClient) {
      this.indexer?.dispose();
      this.indexer = new SemanticIndexer(contextManager, this.semanticClient, this.semanticCfg, (m) => console.warn(m));
      // start() may already have run (framework start before host bind):
      // wire persistence now, or pending changes are neither restored nor saved.
      if (this.ctx) this.wireIndexer(this.ctx);
      else this.indexer.attach();
      this.startSyncTimer();
    }
  }

  /**
   * A host that projects the bound resident's fold receipts to a file
   * (connectome-host's folds.jsonl) reports that export's status here.
   * history--folds shows it, including an export conflict and its target
   * path, to the resident whose context manager was passed to bind(): the
   * export is a projection of that record, not of another caller's.
   */
  setFoldExportStatus(provider: (() => unknown) | null): void {
    this.foldExportStatus = provider ?? undefined;
  }

  /**
   * Resolve an agent-supplied channel spec — a label like `#general` or an
   * already-raw internal channelId — to the internal id used by
   * context-manager's channel-indexed queries, via the bound
   * ChannelRegistry's durable label history (`resolveProseTargetDurable`,
   * which survives the bot disconnecting from or restarting on a channel —
   * exactly the case that matters for browsing OLD history).
   *
   * Falls through the input unchanged when no registry is bound (host
   * without MCPL — today's behavior). On a registry MISS, the response
   * depends on whether the spec actually looks like a label: `#general`,
   * `@name`, or a `<@id>`/`<@!id>` mention (the syntaxes `resolveProseTarget`
   * itself treats as unambiguously label-shaped — see its own leading
   * `#`/`@` and mention-regex handling) is very likely a typo or a
   * never-registered target, not a raw internal id, so a miss there throws
   * a clean tool error (with any `candidates` suggestions folded in)
   * instead of quietly treating it as an empty/nonexistent channel. A
   * mention in particular can never legitimately BE a raw internal
   * channelId, so the escape-hatch rationale below doesn't even apply to
   * it. Anything else is
   * passed through as an escape hatch — an agent can legitimately already
   * hold a raw channelId (e.g. echoed back by a prior
   * `stats`/`extract`/`search`/`overview` call), and erroring on that would
   * break working addressing to "fix" a spec that was never a label at all.
   *
   * The thrown message is deliberately NOT `resolved.error` verbatim:
   * `resolveProseTargetDurable`'s underlying live resolver
   * (`resolveProseTarget`) writes its error text for a SEND context (e.g.
   * a DM miss says '...use the send_dm tool') — sensible advice when
   * you're trying to deliver a message, nonsense advice from a read-only
   * history tool. This module always uses its own read-only-appropriate
   * wording instead, regardless of which branch of the live resolver
   * produced the miss.
   */
  private resolveChannel(input: string | undefined): string | undefined {
    if (!input || !this.channelRegistry) return input;
    const resolved = this.channelRegistry.resolveProseTargetDurable(input);
    if (!('error' in resolved)) return resolved.channelId;
    if (input.startsWith('#') || input.startsWith('@') || DM_MENTION_RE.test(input)) {
      const suggestions = resolved.candidates?.length ? ` Did you mean: ${resolved.candidates.join(', ')}?` : '';
      throw new Error(
        `No channel history found for "${input}" — it may never have been seen by this resident, or predates this feature.${suggestions}`,
      );
    }
    return input;
  }

  /**
   * Earliest message timestamp anywhere in the store, constrained to
   * `toMs` when given (never look past the caller's own upper bound while
   * anchoring). Used by `handleOverview` to anchor its gap-walk cursor when
   * `from` is omitted — see the cursor-anchoring comment there for why
   * falling back to "now" instead is wrong. Cheap: a single native
   * time-indexed query for one message (oldest-first is
   * `queryMessagesByTime`'s default order). Returns undefined for a
   * genuinely empty store (or empty up to `toMs`).
   */
  private earliestMessageMs(toMs: number | undefined): number | undefined {
    const cm = this.cm as ContextManager;
    const probe = cm.queryMessagesByTime({ toMs, limit: 1 });
    return probe.messages[0]?.timestamp.getTime();
  }

  /**
   * Every raw message sharing exactly `ms` (a single-point, both-ends-
   * inclusive time query). Used by `handleOverview`'s boundary-tie
   * disambiguation to see past `getChannelTokenStats`'s aggregate-only,
   * sequence-blind view of a millisecond — see the correction pass there
   * for why. Cheap: at most a handful of messages share one millisecond in
   * practice.
   */
  private boundaryMessagesAt(ms: number): StoredMessage[] {
    const cm = this.cm as ContextManager;
    return cm.queryMessagesByTime({ fromMs: ms, toMs: ms }).messages;
  }

  /** Messages at exactly `ms` (in `channelId` when given). Bounded by
   *  AROUND_TIE_CAP: past it a same-millisecond group is too large to step
   *  through by sequence, and the caller should narrow instead. */
  private countAtMs(ms: number, channelId: string | undefined): number {
    const cm = this.cm as ContextManager;
    const n =
      channelId !== undefined
        ? cm.queryMessagesByTimeAndChannel({ fromMs: ms, toMs: ms, channelId, limit: 0 }).matchedCount
        : cm.queryMessagesByTime({ fromMs: ms, toMs: ms, limit: AROUND_TIE_CAP + 1 }).messages.length;
    if (n > AROUND_TIE_CAP) {
      throw new Error(
        `More than ${AROUND_TIE_CAP} messages share the instant ${new Date(ms).toISOString()}; a continuation can't step ` +
          'through them. Narrow the search with channelId/author instead.',
      );
    }
    return n;
  }

  /** Highest sequence in the store right now (the last append), or -1 when empty. */
  private storeSeqMark(): number {
    const cm = this.cm as ContextManager;
    const count = cm.getMessageCount();
    if (count === 0) return -1;
    return cm.getMessageWindow(count - 1, 1).messages[0]?.sequence ?? -1;
  }

  /**
   * Of the messages appended since `seqMark` (the store's append tail above
   * it, walked back in pages), the ones `relevant` keeps. Unrelated appends
   * cost a look but never count. `complete` is false when the walk stopped
   * at APPENDED_SCAN_CAP before reaching seqMark — the result is then a
   * lower bound, not a verification.
   */
  private appendedSince(
    seqMark: number,
    relevant: (m: StoredMessage) => boolean,
  ): { messages: StoredMessage[]; complete: boolean } {
    const cm = this.cm as ContextManager;
    const out: StoredMessage[] = [];
    let looked = 0;
    let end = cm.getMessageCount();
    while (end > 0) {
      const start = Math.max(0, end - 1000);
      const w = cm.getMessageWindow(start, end - start).messages;
      for (let i = w.length - 1; i >= 0; i--) {
        if (w[i]!.sequence <= seqMark) return { messages: out, complete: true };
        if (relevant(w[i]!)) out.push(w[i]!);
        if (++looked >= APPENDED_SCAN_CAP) return { messages: out, complete: false };
      }
      end = start;
    }
    return { messages: out, complete: true };
  }

  /**
   * Validate a filtered-extract resume position against the window as it is
   * NOW. `afterId` names the message the previous call saw at position
   * `windowOffset - 1`. If it is still there, resume as asked. If the window
   * moved (a removal or an insertion before that point since the previous
   * call), look for it within RELOCATE_RADIUS positions either side and
   * resume just past it, reporting the shift. If it can't be found — it was
   * itself removed, or the window moved further than that — fail loudly:
   * guessing is how a message gets silently skipped.
   */
  private relocateWindowOffset(
    windowOffset: number,
    afterId: string | null | undefined,
    q: { fromMs?: number; toMs?: number; channelId?: string },
  ): { windowOffset: number; shift: number } {
    if (windowOffset === 0) {
      if (afterId != null) throw new Error('"afterId" only applies together with a windowOffset > 0.');
      return { windowOffset, shift: 0 };
    }
    if (afterId == null) {
      throw new Error(
        '"windowOffset" needs the "afterId" from the same `resume` object — without it a message added or removed ' +
          'since the previous call would be silently skipped. Pass the whole `resume` object back.',
      );
    }
    const cm = this.cm as ContextManager;
    const at = cm.queryMessagesByTimeAndChannel({ ...q, limit: 1, offset: windowOffset - 1 }).messages[0];
    if (at && String(at.id) === afterId) return { windowOffset, shift: 0 };
    const lo = Math.max(0, windowOffset - 1 - RELOCATE_RADIUS);
    const around = cm.queryMessagesByTimeAndChannel({ ...q, limit: 2 * RELOCATE_RADIUS + 1, offset: lo }).messages;
    const i = around.findIndex((m) => String(m.id) === afterId);
    if (i === -1) {
      throw new Error(
        `The window changed since the previous call: message ${afterId}, where that scan stopped, is no longer ` +
          `within ${RELOCATE_RADIUS} positions of windowOffset ${windowOffset} (it may have been deleted). ` +
          'Restart the scan without windowOffset/afterId, or narrow it with from/to.',
      );
    }
    const relocated = lo + i + 1;
    return { windowOffset: relocated, shift: relocated - windowOffset };
  }

  /**
   * The `n` messages of a time/channel range nearest one of its edges, in
   * TIMESTAMP order walking away from that edge (newest-first for
   * side:"newest", oldest-first for side:"oldest"), plus whether the range
   * holds more than `n`.
   *
   * Why not just `queryMessagesByTimeAndChannel` + offset: (a) a time-only
   * query's `matchedCount` is the returned PAGE size, not a total (see
   * context-manager MessageStore.queryByTime), so it can't locate a tail;
   * (b) channel-scoped results come back in APPEND (ordinal) order, and
   * Discord catch-up appends old-timestamped messages late — an ordinal
   * tail is not the timestamp tail.
   *
   * No channel: chronicle's timestamp index answers directly (`reverse`
   * for the newest edge). With a channel: channel queries report an exact
   * matchedCount, so grow a time window out from the edge (×4 per step)
   * until it holds ≥ n channel messages or covers the whole range. If that
   * window holds more than `fetchCap` (a density jump across one step, or a
   * burst), bisect its far bound between the last step that held < n and
   * this one — counts are exact, so it lands on a window of [n, fetchCap].
   * Only when a single millisecond holds the overflow does bisection bottom
   * out; then the window is everything strictly nearer the edge plus that
   * millisecond's nearest messages by sequence, which within one millisecond
   * IS the (timestamp, sequence) order — still exact. The newest side is
   * left open when `toMs` is (clock-skewed future stamps stay visible).
   */
  private edgeWindow(opts: {
    fromMs?: number;
    toMs?: number;
    channelId?: string;
    n: number;
    side: 'newest' | 'oldest';
  }): { messages: StoredMessage[]; more: boolean } {
    const cm = this.cm as ContextManager;
    const { fromMs, toMs, channelId, n, side } = opts;
    const newest = side === 'newest';
    const cmp = (a: StoredMessage, b: StoredMessage) =>
      a.timestamp.getTime() - b.timestamp.getTime() || a.sequence - b.sequence;
    const dirSort = (ms: StoredMessage[]) => ms.sort(newest ? (a, b) => cmp(b, a) : cmp);

    if (channelId === undefined) {
      const r = cm.queryMessagesByTime({ fromMs, toMs, limit: n + 1, reverse: newest });
      return { messages: r.messages.slice(0, n), more: r.messages.length > n };
    }

    const count = (f?: number, t?: number) =>
      cm.queryMessagesByTimeAndChannel({ fromMs: f, toMs: t, channelId, limit: 0 }).matchedCount;
    const fetch = (f: number | undefined, t: number | undefined, limit: number, offset = 0) =>
      limit <= 0 ? [] : cm.queryMessagesByTimeAndChannel({ fromMs: f, toMs: t, channelId, limit, offset }).messages;
    const total = count(fromMs, toMs);
    if (n === 0) return { messages: [], more: total > 0 };
    if (total <= n) return { messages: dirSort(fetch(fromMs, toMs, total)), more: false };

    // The window is parameterised by its FAR bound `e`: [e, toMs] for the
    // newest side, [fromMs, e] for the oldest; its count is monotone in e.
    const win = (e: number): [number | undefined, number | undefined] => (newest ? [e, toMs] : [fromMs, e]);
    const cnt = (e: number) => count(...win(e));
    const lo = fromMs ?? this.earliestMessageMs(toMs) ?? 0;
    const hi = toMs ?? Date.now(); // growth anchor only — never a bound
    // `outside`: a far bound whose window holds < n (initially empty).
    // `inside`: one whose window holds ≥ n (initially the whole range).
    let outside: number | null = null;
    let inside = newest ? lo : (toMs ?? MAX_DATE_MS);
    let inCount = total;
    for (let width = 10 * 60_000; ; width *= 4) {
      const e = newest ? hi - width : lo + width;
      if (newest ? e <= lo : e >= hi) break; // covered: keep the whole range
      const c = cnt(e);
      if (c >= n) {
        inside = e;
        inCount = c;
        break;
      }
      outside = e;
    }
    const fetchCap = Math.max(4 * n, n + 1000);
    if (inCount <= fetchCap) {
      return { messages: dirSort(fetch(...win(inside), inCount)).slice(0, n), more: true };
    }
    // Overshoot: bisect the far bound. The empty side starts one past the
    // range's near end (newest: past toMs / any date; oldest: before lo).
    const emptyOut = newest ? (toMs ?? MAX_DATE_MS) + 1 : lo - 1;
    let out = outside ?? emptyOut;
    while (Math.abs(inside - out) > 1) {
      const mid = Math.floor((inside + out) / 2);
      const c = cnt(mid);
      if (c < n) {
        out = mid;
      } else {
        inside = mid;
        inCount = c;
        if (c <= fetchCap) {
          return { messages: dirSort(fetch(...win(mid), c)).slice(0, n), more: true };
        }
      }
    }
    // Millisecond `inside` alone carries the overflow. Everything nearer the
    // edge (the `out` window, < n messages) plus the nearest-by-sequence
    // messages of that millisecond (channel pages are append = sequence
    // ordered, which is the tie order within one millisecond).
    const near = out === emptyOut ? [] : fetch(...win(out), cnt(out));
    const need = n - near.length;
    const ties = count(inside, inside);
    const edgeMs = fetch(inside, inside, need, newest ? Math.max(0, ties - need) : 0);
    return { messages: dirSort([...near, ...edgeMs]).slice(0, n), more: true };
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    this.wireIndexer(ctx);
    this.startSyncTimer();
  }

  /** Pending edits/removals survive a restart through module state. Called from whichever of start()/bind() runs second. */
  private wireIndexer(ctx: ModuleContext): void {
    if (!this.indexer) return;
    this.indexer.restorePending(ctx.getState<{ semanticPending?: PendingChanges }>()?.semanticPending);
    this.indexer.onPendingChange = (p) => {
      const prev = this.ctx?.getState<Record<string, unknown>>() ?? {};
      this.ctx?.setState({ ...prev, semanticPending: p });
    };
    this.indexer.attach();
  }

  async stop(): Promise<void> {
    this.ctx = null;
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    if (this.firstSyncTimer) { clearTimeout(this.firstSyncTimer); this.firstSyncTimer = null; }
    if (this.indexer) this.indexer.onPendingChange = null;
    this.indexer?.dispose();
  }

  /**
   * Background sync into the semantic index: every `syncIntervalMs` (default
   * 60 s) push up to `maxSyncPerTick` new items. Idempotent to call — starts
   * once we have both a context-manager (bind) and a config; `unref`'d so it
   * never keeps a shutting-down process alive. A first tick runs after 5 s so
   * a fresh store starts backfilling immediately rather than a minute later.
   */
  private startSyncTimer(): void {
    if (this.syncTimer || !this.indexer || !this.semanticCfg) return;
    const interval = this.semanticCfg.syncIntervalMs ?? 60_000;
    if (interval <= 0) return;
    const perTick = this.semanticCfg.maxSyncPerTick ?? 1024;
    const tick = (): void => { void this.indexer?.catchUp(perTick); };
    this.firstSyncTimer = setTimeout(() => { this.firstSyncTimer = null; tick(); }, 5_000);
    this.firstSyncTimer.unref?.();
    this.syncTimer = setInterval(tick, interval); this.syncTimer.unref?.();
  }

  /** Exposed for hosts/tests: one sync pass now. */
  syncSemanticIndex(maxItems = 1024): Promise<SyncReport> | null {
    return this.indexer ? this.indexer.catchUp(maxItems) : null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'stats',
        description:
          'Orient before pulling raw history: per-channel message counts and token totals. ' +
          'messageCountsAllTime is always all-time and all-channel-scope (the underlying index has no ' +
          'range dimension) — it is NOT limited by from/to, only optionally filtered to one channelId. ' +
          'tokenStatsForRange IS scoped to from/to when given. The two are reported separately, never ' +
          'merged, because their range semantics differ.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            from: { type: 'string', description: 'ISO 8601 inclusive lower bound for tokenStatsForRange. Omit for open-ended.' },
            to: { type: 'string', description: 'ISO 8601 inclusive upper bound for tokenStatsForRange. Omit for open-ended.' },
            channelId: { type: 'string', description: 'Restrict both parts of the response to one channel. Accepts a channel label (e.g. "#general") or the raw internal channel id.' },
          },
        },
      },
      {
        name: 'extract',
        description:
          'Fetch raw, uncompressed messages for a time range and/or channel, paginated oldest-first. ' +
          'Use after `stats` to pull the actual content. format:"text" flattens each message to a short ' +
          'readable string (tool_use/tool_result/thinking/images rendered as bracketed labels); ' +
          'format:"raw" returns the content blocks unmodified. ' +
          'Two extra modes: (1) aroundId — pass a message id (e.g. from `search`) to get the conversation ' +
          'around it: `before` messages before it, the message itself (anchor:true), and `after` messages ' +
          'after it, in the anchor\'s own channel unless channelId/allChannels says otherwise; from/to/offset/limit ' +
          'do not apply in this mode (at most before+after+1 messages). (2) author/excludeAuthor — keep only (or drop) messages by these ' +
          'authors; this is filtered in-process over at most maxScan messages of the window, so a response ' +
          'may report truncated:true with a `resume` object ({windowOffset, offset, afterId}) — repeat the call with ' +
          'those fields added to continue exactly where it stopped. If messages were added or removed in the window ' +
          'meanwhile, the resume re-anchors on afterId and says so (windowChanged), or fails loudly when it can\'t.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            from: { type: 'string', description: 'ISO 8601 inclusive lower bound. Omit for open-ended.' },
            to: { type: 'string', description: 'ISO 8601 inclusive upper bound. Omit for open-ended.' },
            channelId: { type: 'string', description: 'Restrict to one channel. Accepts a channel label (e.g. "#general") or the raw internal channel id.' },
            author: AUTHOR_SCHEMA,
            excludeAuthor: EXCLUDE_AUTHOR_SCHEMA,
            aroundId: { type: 'string', description: 'Message id to center on (as returned by search/extract; a "msg:<id>" hit id works too). Returns the surrounding conversation instead of a range.' },
            before: { type: 'number', description: `With aroundId: messages to include before the anchor (default ${AROUND_DEFAULT}, cap ${AROUND_MAX}).` },
            after: { type: 'number', description: `With aroundId: messages to include after the anchor (default ${AROUND_DEFAULT}, cap ${AROUND_MAX}).` },
            allChannels: { type: 'boolean', description: 'With aroundId: interleave every channel around the anchor\'s time instead of staying in its channel (default false).' },
            limit: { type: 'number', description: `Max messages to return (default ${EXTRACT_DEFAULT_LIMIT}, hard cap ${EXTRACT_MAX_LIMIT}). Must be a non-negative integer.` },
            offset: { type: 'number', description: `Number of matching messages to skip (default 0, capped to ${NATIVE_OFFSET_MAX}). Must be a non-negative integer.` },
            maxScan: { type: 'number', description: `With author/excludeAuthor: max window messages to examine (default ${EXTRACT_FILTER_DEFAULT_MAX_SCAN}, hard cap ${EXTRACT_FILTER_MAX_MAX_SCAN}).` },
            windowOffset: { type: 'number', description: 'With author/excludeAuthor: resume a truncated scan at this position of the window — copy it from the previous response\'s `resume`.' },
            seqMark: { type: 'number', description: 'With windowOffset and no channelId: copy it from `resume`. Lets a resume find messages added behind it since the previous call.' },
            afterId: { type: 'string', description: 'With windowOffset: id of the last message the previous call scanned — copy it from `resume`. Lets a resume notice messages added or removed since, instead of silently skipping one.' },
            format: { type: 'string', enum: ['text', 'raw'], description: 'Content rendering (default "text").' },
          },
        },
      },
      {
        name: 'search',
        description:
          'Search message history for a substring (default) or regex match, within an optional time ' +
          'range/channel window. Narrows candidates via the same query as `extract` before matching, up ' +
          'to maxScan candidates — if the narrowed window is larger than maxScan, the response reports ' +
          'truncated:true up front rather than silently missing later matches; narrow the filter or raise ' +
          'maxScan and retry. When the scan stops early (truncated, or `limit` matches reached) the response ' +
          'carries a `resume` object ({from|to, skipSequences}): repeat the call with its fields to continue ' +
          '(scannedThrough is the same instant, for reading). ' +
          'order:"newest" scans the most recent maxScan messages of the window first — usually what you want ' +
          'for "when did this last come up". author/excludeAuthor narrow by who wrote the message; ' +
          'wholeWord:true stops "mission" from matching inside "uncommissioned". Each match carries an `id` ' +
          'you can hand to extract({aroundId}) to read the conversation around it. ' +
          'regex:true matching runs under a wall-clock deadline and is cleanly failed ' +
          `(not silently empty) if a pattern is too slow — avoid nested-quantifier patterns like (a+)+.`,
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Substring (or regex source, when regex:true) to search for.' },
            regex: { type: 'boolean', description: 'Treat query as a regular expression (default false).' },
            caseSensitive: { type: 'boolean', description: 'Case-sensitive match (default false).' },
            wholeWord: { type: 'boolean', description: 'Substring mode only: match whole words, not inside longer words (default false). In regex mode use \\b yourself.' },
            from: { type: 'string', description: 'ISO 8601 inclusive lower bound. Omit for open-ended.' },
            to: { type: 'string', description: 'ISO 8601 inclusive upper bound. Omit for open-ended.' },
            channelId: { type: 'string', description: 'Restrict to one channel. Accepts a channel label (e.g. "#general") or the raw internal channel id.' },
            author: AUTHOR_SCHEMA,
            excludeAuthor: EXCLUDE_AUTHOR_SCHEMA,
            order: { type: 'string', enum: ['oldest', 'newest'], description: 'Scan and return oldest-first (default) or newest-first.' },
            limit: { type: 'number', description: `Max matches to return (default ${SEARCH_DEFAULT_LIMIT}, hard cap ${SEARCH_MAX_LIMIT}). Must be a non-negative integer.` },
            maxScan: { type: 'number', description: `Max candidate messages to scan (default ${SEARCH_DEFAULT_MAX_SCAN}, hard cap ${SEARCH_MAX_MAX_SCAN}). Must be a non-negative integer.` },
            skipSequences: {
              type: 'array',
              items: { type: 'number' },
              description: 'Continuation only: copy it from the previous response\'s `resume` together with its from/to. Marks the messages at exactly that instant that were already scanned.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'overview',
        description:
          'Browse a time range when you don\'t know exactly what you\'re looking for yet: returns existing ' +
          'compression summaries as a table of contents, at zero new LLM cost (purely a read over summaries ' +
          'already produced by compression). Spans not yet summarized fall back to raw message counts, ' +
          'marked summarized:false. Omit `level` to let each span show its own coarsest available summary ' +
          '(spans can end up at DIFFERENT levels — the response then reports maxLevelAvailable rather than ' +
          'a single `level`, since no one number would describe a mixed result); pass an exact `level` for ' +
          'flat, single-granularity results instead (finer detail = lower level), and the response then ' +
          'echoes that `level` back. `channelId` (a label like "#general" or the raw internal id) narrows ' +
          'WHICH spans are shown (only spans with at least one message from that channel) and scopes each ' +
          'entry\'s messageCount/tokensEstimate to that channel\'s own numbers (spanMessageCount/' +
          'spanTokensEstimate carry the whole-span totals alongside, for context) — but does NOT scope a ' +
          'kept entry\'s summary TEXT to that channel: compression doesn\'t chunk per-channel, so a ' +
          'summary may describe other channels\' traffic too. A wide or unbounded from/to can be expensive ' +
          'on a cold cache — same cost class as `stats`\'s tokenStatsForRange — since gap-filling still ' +
          'walks the underlying message range wherever nothing has been summarized yet. Response spans are ' +
          'capped at `limit`, keeping the MOST RECENT spans and reporting truncated:true + totalSpans when ' +
          'more exist — narrow the range or raise `limit` to see further back. `from` after `to` is rejected ' +
          'with a clear error rather than silently returning no spans. An entry marked boundaryUncertain:true ' +
          'had a millisecond-timestamp collision at its edge with another span (rare — two distinct messages ' +
          'landing in the same millisecond); its messageCount is still exact but tokensEstimate may be off by ' +
          'a small, bounded amount.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            from: { type: 'string', description: 'ISO 8601 inclusive lower bound. Omit for open-ended.' },
            to: { type: 'string', description: 'ISO 8601 inclusive upper bound. Omit for open-ended.' },
            channelId: { type: 'string', description: 'Only show spans with traffic from this channel. Accepts a channel label (e.g. "#general") or the raw internal channel id.' },
            level: {
              type: 'number',
              description:
                'Exact summary level to fetch, flat (no fold-reduction across levels). Omit to default to ' +
                'each span\'s own coarsest currently-available summary (a mix of levels across the response ' +
                'is expected and normal), reduced so a folded summary\'s now-superseded child does not also ' +
                'appear alongside a coarser entry that already covers its span.',
            },
            limit: {
              type: 'number',
              description: `Max spans to return, keeping the most recent (default ${OVERVIEW_DEFAULT_LIMIT}, hard cap ${OVERVIEW_MAX_LIMIT}). Must be a non-negative integer.`,
            },
          },
        },
      },
      FOLDS_TOOL,
      ...(this.semanticCfg ? [this.semanticSearchTool()] : []),
    ];
  }

  private semanticSearchTool(): ToolDefinition {
    return {
      name: 'semantic_search',
      description:
        'Search your own history by MEANING, not exact words: an embedding index over your raw messages ' +
        '(text plus your own think/journal/skip_reply notes) and every compression summary. Use it when you ' +
        'remember roughly what something was about but not the words — "the night the fluid sim was read ' +
        'back to me as art" — then narrow with `from`/`to`/`channelId` and drill into the exact span with ' +
        '`extract` or `overview` (for a message hit, `extract({ aroundId: messageId })` opens the conversation ' +
        'around it — use the raw `messageId` field, not the `msg:` id). Results are ranked by cosine similarity (score ~0.6+ is a strong match, ' +
        '~0.3 is thematic, below ~0.2 is noise); each hit carries its id (`msg:<id>` or `sum:<id>`), ' +
        'timestamp, channel, kind/level and a snippet. The index catches up with recent messages before ' +
        'searching (bounded, so a huge backlog is reported as `index.behind` rather than blocking; if a ' +
        'background sync is already running, the search waits for that run to finish instead). ' +
        'Purely a read: nothing is written to your history. Hits are checked against your current branch ' +
        'before they come back: a message you undid or a summary from a branch you left is dropped and ' +
        'counted in index.droppedOffBranch; a message edited down to nothing searchable is dropped and ' +
        'counted in index.droppedStale. Message snippets always show the current text of the message.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'What you are looking for, in natural language. A sentence works better than keywords.' },
          limit: { type: 'number', description: `Max hits (default ${SEMANTIC_DEFAULT_LIMIT}, cap ${SEMANTIC_MAX_LIMIT}).` },
          from: { type: 'string', description: 'ISO 8601 inclusive lower bound on the message timestamp / summary span start. Omit for open-ended.' },
          to: { type: 'string', description: 'ISO 8601 inclusive upper bound. Omit for open-ended.' },
          channelId: { type: 'string', description: 'Only raw messages from this channel (label like "#general" or the raw internal id). Summaries are not per-channel and are excluded when this is set; combining it with kinds="summaries" or level is an error.' },
          kinds: { type: 'string', enum: ['messages', 'summaries', 'both'], description: 'What to search: raw messages, compression summaries, or both (default).' },
          level: { type: 'number', description: 'Only summaries of this exact level (implies kinds=summaries).' },
          minScore: { type: 'number', description: 'Drop hits below this cosine score (0..1). Default none.' },
        },
        required: ['query'],
      },
    };
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    try {
      if (!this.cm) {
        throw new Error('HistoryModule not bound — host must call bind(contextManager) before tool dispatch.');
      }
      switch (call.name) {
        case 'stats':
          return this.handleStats((call.input ?? {}) as StatsInput);
        case 'extract':
          return this.handleExtract((call.input ?? {}) as ExtractInput);
        case 'search':
          return await this.handleSearch((call.input ?? {}) as SearchInput);
        case 'overview':
          return this.handleOverview((call.input ?? {}) as OverviewInput);
        case 'semantic_search':
          return await this.handleSemanticSearch((call.input ?? {}) as SemanticSearchInput);
        case 'folds':
          return this.handleFoldsCall(call);
        default:
          return { success: false, isError: true, error: `Unknown tool: ${call.name}` };
      }
    } catch (error) {
      // Catches our own validation errors (bad ISO date, invalid regex,
      // out-of-range limit/offset/maxScan, unbound module), a regex-search
      // worker timeout or worker-side error (see handleSearch/
      // searchWithRegexWorker — a ReDoS-shaped pattern surfaces here as a
      // clean timeout error, never a hang), and context-manager's
      // capability-absent error ("Chronicle history index unsupported...",
      // thrown by queryMessagesByTime/queryMessagesByChannel/
      // queryMessagesByTimeAndChannel/getChannelMessageCounts/
      // getChannelTokenStats/getSummariesInRange/getMaxSummaryLevel on a
      // chronicle/strategy build that predates the relevant capability) —
      // all surfaced as a normal tool error rather than crashing the module.
      return {
        success: false,
        isError: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * history--folds answers for the agent that called it. Each agent accepts
   * its rounds through its own context manager, whose strategy and fold
   * journal are its own (a conversation fork's or a second resident's are
   * not the bound resident's, though they share a store), so the caller's is
   * resolved by name. A call without a resolvable caller has no record to
   * show.
   */
  private handleFoldsCall(call: ToolCall): ToolResult {
    const caller = call.callerAgentName;
    const cm = caller ? this.ctx?.getAgentContextManager(caller) ?? null : null;
    if (!cm) {
      return {
        success: false,
        isError: true,
        error: caller
          ? `No fold record for "${caller}": no agent by that name is registered.`
          : 'history--folds shows the calling agent\'s fold record, and this call has no calling agent.',
      };
    }
    const exportStatus = cm === this.cm ? this.foldExportStatus?.() : undefined;
    return handleFolds(cm, (call.input ?? {}) as FoldsInput, exportStatus);
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // ==========================================================================
  // stats
  // ==========================================================================

  private handleStats(input: StatsInput): ToolResult {
    const channelId = this.resolveChannel(input.channelId);
    const fromMs = parseIsoDate(input.from, 'from');
    const toMs = parseIsoDate(input.to, 'to');
    const cm = this.cm as ContextManager;

    let messageCountsAllTime: ChannelCount[] = cm.getChannelMessageCounts();
    let tokenStatsForRange: ChannelTokenStats = cm.getChannelTokenStats({ fromMs, toMs });

    if (channelId) {
      messageCountsAllTime = messageCountsAllTime.filter((c) => c.channelId === channelId);
      tokenStatsForRange = {
        // Totals stay whole-range (they're documented as store-wide-for-the-range,
        // not per-channel); only the byChannel breakdown is narrowed. Labeling the
        // field `byChannel` (rather than folding a channel-filtered total into
        // totalMessages/totalTokensEstimate) keeps this from reading as a
        // misleadingly-merged single-channel total.
        totalMessages: tokenStatsForRange.totalMessages,
        totalTokensEstimate: tokenStatsForRange.totalTokensEstimate,
        byChannel: tokenStatsForRange.byChannel.filter((c) => c.channelId === channelId),
      };
    }

    return {
      success: true,
      data: {
        query: { from: input.from ?? null, to: input.to ?? null, channelId: input.channelId ?? null },
        messageCountsAllTime,
        tokenStatsForRange,
      },
    };
  }

  // ==========================================================================
  // extract
  // ==========================================================================

  private handleExtract(input: ExtractInput): ToolResult {
    if (input.aroundId !== undefined) return this.handleExtractAround(input);
    if (input.before !== undefined || input.after !== undefined || input.allChannels !== undefined) {
      throw new Error('"before"/"after"/"allChannels" only apply together with "aroundId".');
    }
    const channelId = this.resolveChannel(input.channelId);
    const fromMs = parseIsoDate(input.from, 'from');
    const toMs = parseIsoDate(input.to, 'to');
    const limit = clampCount(input.limit, EXTRACT_DEFAULT_LIMIT, EXTRACT_MAX_LIMIT, 'limit');
    const offset = clampCount(input.offset, 0, NATIVE_OFFSET_MAX, 'offset');
    const format = input.format ?? 'text';
    const authorFilter = buildAuthorFilter(input.author, input.excludeAuthor);

    const cm = this.cm as ContextManager;
    if (!authorFilter && (input.windowOffset !== undefined || input.afterId !== undefined || input.seqMark !== undefined)) {
      throw new Error('"windowOffset"/"afterId" only apply together with author/excludeAuthor (they resume a filtered scan). Use offset.');
    }

    if (authorFilter) {
      // No native author index: page through the time/channel window and
      // filter here. offset/limit apply to the FILTERED sequence. Stop as
      // soon as the requested page is full; otherwise scan to maxScan. Only
      // an exhausted window yields an exact matchedCount — anything else is
      // reported as truncated with a resume point, never as a total.
      //
      // Resume is by WINDOW POSITION (`windowOffset`), never by timestamp: a
      // channel-scoped window pages in append order, and Discord catch-up
      // appends old-timestamped messages late, so "continue from the last
      // timestamp seen" would skip them.
      const maxScan = clampCount(input.maxScan, EXTRACT_FILTER_DEFAULT_MAX_SCAN, EXTRACT_FILTER_MAX_MAX_SCAN, 'maxScan');
      if (maxScan === 0) throw new Error('"maxScan" must be at least 1 for an author-filtered extract.');
      const requestedOffset = clampCount(input.windowOffset, 0, NATIVE_OFFSET_MAX, 'windowOffset');
      // A position is only meaningful against the window it was taken in:
      // a removal before it (every discord:delete, host hide, /undo) shifts
      // later positions left, and a message inserted before it (a
      // time-ordered window with backfill) shifts them right. Either would
      // silently skip or repeat a message. afterId pins the position to the
      // message that was there; relocate it if the window moved.
      const { windowOffset, shift } = this.relocateWindowOffset(
        requestedOffset,
        input.afterId,
        { fromMs, toMs, channelId },
      );
      // A time-ordered window (no channelId) can also take an older-stamped
      // insertion BEFORE the cursor; paired with a removal there, positions
      // balance out (shift 0) and afterId alone can't see it. Appends carry
      // the highest sequences, so everything appended since the previous
      // call is the store's append tail above its seqMark: check those
      // directly. (A channel window pages in append order, so an append
      // always lands after the cursor and is simply scanned.)
      const seqMarkNow = channelId === undefined ? this.storeSeqMark() : undefined;
      let missed: StoredMessage[] = [];
      let unverified = false;
      if (channelId === undefined && windowOffset > 0) {
        if (typeof input.seqMark !== 'number') {
          throw new Error(
            '"windowOffset" without channelId needs the "seqMark" from the same `resume` object. Pass the whole `resume` object back.',
          );
        }
        const cursor = cm.queryMessagesByTimeAndChannel({ fromMs, toMs, limit: 1, offset: windowOffset - 1 }).messages[0];
        if (cursor) {
          const ct = cursor.timestamp.getTime();
          const r = this.appendedSince(input.seqMark, (m) => {
            const ts = m.timestamp.getTime();
            if ((fromMs !== undefined && ts < fromMs) || (toMs !== undefined && ts > toMs)) return false;
            return ts < ct || (ts === ct && m.sequence < cursor.sequence);
          });
          missed = r.messages;
          unverified = !r.complete;
        }
      }
      const page: StoredMessage[] = [];
      let kept = 0;
      let scanned = 0;
      let lastScanned: StoredMessage | undefined;
      // Window position just past the last message put on the page, and that message.
      let afterPage = windowOffset;
      let lastOnPage: StoredMessage | undefined;
      let exhausted = false;
      let pageFull = false;
      outer: for (;;) {
        const want = Math.min(FILTER_SCAN_PAGE, maxScan - scanned);
        if (want <= 0) break;
        const chunk = cm.queryMessagesByTimeAndChannel({
          fromMs,
          toMs,
          channelId,
          limit: want,
          offset: Math.min(windowOffset + scanned, NATIVE_OFFSET_MAX),
        }).messages;
        for (const m of chunk) {
          scanned++;
          lastScanned = m;
          if (!authorFilter(m)) continue;
          if (kept >= offset && page.length < limit) {
            page.push(m);
            afterPage = windowOffset + scanned;
            lastOnPage = m;
          }
          kept++;
          if (limit > 0 && page.length >= limit && kept > offset + limit) {
            // One filtered match beyond the page proves there is more;
            // no need to keep scanning.
            pageFull = true;
            break outer;
          }
        }
        if (chunk.length < want) {
          exhausted = true;
          break;
        }
      }
      if (!exhausted && !pageFull && scanned >= maxScan) {
        // Probe one past maxScan: a window of exactly maxScan is complete.
        const next = cm.queryMessagesByTimeAndChannel({
          fromMs,
          toMs,
          channelId,
          limit: 1,
          offset: Math.min(windowOffset + scanned, NATIVE_OFFSET_MAX),
        }).messages;
        if (next.length === 0) exhausted = true;
      }
      return {
        success: true,
        data: {
          // A resumed scan (windowOffset > 0) only saw the window from that
          // position on, so its count is named for that — never a total. A
          // page-full stop's lookahead match lies past the resume point and
          // is left out, so counts add up across a chain of resumes.
          ...(() => {
            const n = pageFull ? kept - 1 : kept;
            const base = windowOffset > 0 ? 'matchedSinceWindowOffset' : 'matchedCount';
            return { [exhausted ? base : `${base}AtLeast`]: n };
          })(),
          returned: page.length,
          scanned,
          truncated: !exhausted,
          ...(shift !== 0 || missed.length > 0 || unverified
            ? {
                windowChanged: {
                  shift,
                  ...(unverified
                    ? {
                        unverified: true,
                        unverifiedNote:
                          `More than ${APPENDED_SCAN_CAP} messages were appended since the previous call; only the newest ` +
                          'were checked, so messages may have been added behind the resume point unseen. Restart without ' +
                          'windowOffset, or narrow with from/to/channelId, if that matters.',
                      }
                    : {}),
                  ...(channelId === undefined
                    ? {
                        addedBefore: missed.length,
                        // the ones this filter would have kept — fetch them with extract({aroundId})
                        missedIds: missed.filter(authorFilter).map((m) => String(m.id)),
                      }
                    : {}),
                  note:
                    missed.length > 0 || shift > 0
                      ? `${missed.length || shift} message(s) were added to the window before the resume point since the previous call; this scan chain did not see them` +
                        (channelId === undefined ? ' (matching ones listed in missedIds).' : '.')
                      : shift < 0
                        ? `${-shift} message(s) before the resume point were removed since the previous call; the resume was re-anchored, nothing skipped.`
                        : 'No change found behind the resume point, but the check was incomplete (see unverifiedNote).',
                },
              }
            : {}),
          ...(!exhausted
            ? (() => {
                // pageFull: resume just past the last returned message, no
                // skip. maxScan: resume past everything scanned, still owing
                // whatever part of `offset` was not yet consumed.
                // afterId = the message at position windowOffset-1 (see
                // relocateWindowOffset). When nothing was scanned (no
                // chunk came back), carry the incoming anchor forward.
                const mark = seqMarkNow !== undefined ? { seqMark: seqMarkNow } : {};
                const resume = pageFull
                  ? { windowOffset: afterPage, offset: 0, afterId: idOrNull(lastOnPage) ?? input.afterId ?? null, ...mark }
                  : {
                      windowOffset: windowOffset + scanned,
                      offset: Math.max(0, offset - kept),
                      afterId: idOrNull(lastScanned) ?? input.afterId ?? null,
                      ...mark,
                    };
                return {
                  resume,
                  hint:
                    (pageFull
                      ? 'More matching messages exist. '
                      : `Stopped after scanning ${scanned} messages of the window without reaching its end. `) +
                    `Continue by repeating this call with the same from/to/channelId/author plus ` +
                    `the fields of \`resume\` (windowOffset:${resume.windowOffset}, offset:${resume.offset}, afterId).`,
                };
              })()
            : {}),
          messages: page.map((msg) => projectMessage(msg, format)),
        },
      };
    }

    // One extra row answers "is there another page" in every case. The
    // native matchedCount is a true total only for channel-scoped queries;
    // for time-only/unfiltered ones it is just the page size (see
    // edgeWindow), so it is reported only where it means what it says.
    const result = cm.queryMessagesByTimeAndChannel({
      fromMs,
      toMs,
      channelId,
      limit: limit + 1,
      offset,
    });
    const page = result.messages.slice(0, limit);

    return {
      success: true,
      data: {
        ...(channelId !== undefined ? { matchedCount: result.matchedCount } : {}),
        returned: page.length,
        hasMore: result.messages.length > limit,
        messages: page.map((msg) => projectMessage(msg, format)),
      },
    };
  }

  /**
   * `extract({aroundId})` — the conversation around one message, like
   * Discord's fetch_around. Neighbours are by (timestamp, sequence): first
   * the anchor's own millisecond in sequence order, then, for whatever a
   * side still needs, the nearest messages strictly before/after it (both
   * via edgeWindow, which is exact by timestamp).
   */
  private handleExtractAround(input: ExtractInput): ToolResult {
    if (
      input.from !== undefined ||
      input.to !== undefined ||
      input.offset !== undefined ||
      input.windowOffset !== undefined ||
      input.limit !== undefined
    ) {
      throw new Error(
        '"aroundId" cannot be combined with from/to/offset/windowOffset/limit — it picks its own window; size it with before/after.',
      );
    }
    if (input.author !== undefined || input.excludeAuthor !== undefined) {
      throw new Error('"aroundId" returns the whole conversation around a message; author filters do not apply. Use search/extract with author instead.');
    }
    if (input.allChannels && input.channelId !== undefined) {
      throw new Error('Pass either "channelId" or "allChannels", not both.');
    }
    const before = clampCount(input.before, AROUND_DEFAULT, AROUND_MAX, 'before');
    const after = clampCount(input.after, AROUND_DEFAULT, AROUND_MAX, 'after');
    const format = input.format ?? 'text';
    const cm = this.cm as ContextManager;

    // semantic_search (#173) hands out `msg:<id>` / `sum:<id>`; accept the
    // message form as-is, and say plainly what a summary id is.
    const rawId = String(input.aroundId);
    if (/^sum:/.test(rawId)) {
      throw new Error(
        `${rawId} is a compression summary, not a message — use overview for summaries, or aroundId with a msg: hit.`,
      );
    }
    const anchor = cm.getMessage(rawId.replace(/^msg:/, ''));
    if (!anchor) {
      throw new Error(`No message with id ${JSON.stringify(input.aroundId)} in this history.`);
    }
    const anchorId = String(anchor.id);
    const anchorChannel = getChannelId(anchor);
    const channelId = input.allChannels ? undefined : (this.resolveChannel(input.channelId) ?? anchorChannel);
    const t = anchor.timestamp.getTime();

    // The anchor's own millisecond first, whole and in sequence order —
    // that is the (timestamp, sequence) order the neighbours are defined
    // by, and it may hold many messages (a backfill burst). Then only if a
    // side still needs more, the nearest messages strictly before / after
    // that millisecond (edgeWindow is exact by timestamp).
    let ties: StoredMessage[];
    if (channelId !== undefined) {
      const n = cm.queryMessagesByTimeAndChannel({ fromMs: t, toMs: t, channelId, limit: 0 }).matchedCount;
      if (n > AROUND_TIE_CAP) throw tieCapError(anchorId, n);
      ties = cm.queryMessagesByTimeAndChannel({ fromMs: t, toMs: t, channelId, limit: n }).messages;
    } else {
      ties = cm.queryMessagesByTime({ fromMs: t, toMs: t, limit: AROUND_TIE_CAP + 1 }).messages;
      if (ties.length > AROUND_TIE_CAP) throw tieCapError(anchorId, ties.length);
    }
    ties = [...ties].sort((x, y) => x.sequence - y.sequence);
    const idx = ties.findIndex((m) => String(m.id) === anchorId);
    if (idx === -1) {
      // The anchor is in the store and every message of its millisecond in
      // `channelId` was fetched, so only an explicit channelId excludes it.
      throw new Error(
        `Message ${anchorId} is not in channel ${JSON.stringify(input.channelId)}` +
          (anchorChannel ? ` (it is in ${anchorChannel}).` : '.') +
          ' Omit channelId to use the anchor\'s own channel.',
      );
    }
    const tiesBefore = ties.slice(Math.max(0, idx - before), idx);
    const tiesAfter = ties.slice(idx + 1, idx + 1 + after);
    const needBefore = before - tiesBefore.length;
    const needAfter = after - tiesAfter.length;
    const earlier =
      needBefore > 0 ? this.edgeWindow({ toMs: t - 1, channelId, n: needBefore, side: 'newest' }).messages.reverse() : [];
    const later = needAfter > 0 ? this.edgeWindow({ fromMs: t + 1, channelId, n: needAfter, side: 'oldest' }).messages : [];
    const window = [...earlier, ...tiesBefore, ties[idx]!, ...tiesAfter, ...later];
    return {
      success: true,
      data: {
        anchorId,
        channelId: channelId ?? null,
        returned: window.length,
        messages: window.map((m) => ({
          ...projectMessage(m, format),
          ...(String(m.id) === anchorId ? { anchor: true } : {}),
        })),
      },
    };
  }

  // ==========================================================================
  // search
  // ==========================================================================

  private async handleSearch(input: SearchInput): Promise<ToolResult> {
    if (!input.query) {
      throw new Error('search requires a non-empty "query".');
    }
    const channelId = this.resolveChannel(input.channelId);
    const fromMs = parseIsoDate(input.from, 'from');
    const toMs = parseIsoDate(input.to, 'to');
    const limit = clampCount(input.limit, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, 'limit');
    const maxScan = clampCount(input.maxScan, SEARCH_DEFAULT_MAX_SCAN, SEARCH_MAX_MAX_SCAN, 'maxScan');
    const caseSensitive = input.caseSensitive ?? false;
    const flags = caseSensitive ? '' : 'i';
    const order = input.order ?? 'oldest';
    if (order !== 'oldest' && order !== 'newest') {
      throw new Error(`"order" must be "oldest" or "newest", got ${JSON.stringify(input.order)}.`);
    }
    if (input.wholeWord && input.regex) {
      throw new Error('"wholeWord" applies to substring search only; in regex mode write \\b around the pattern instead.');
    }
    const authorFilter = buildAuthorFilter(input.author, input.excludeAuthor);

    // Validate regex SYNTAX up front — an invalid pattern is a clean tool
    // error, not a crash mid-scan. This does NOT bound match TIME (a
    // syntactically valid pattern can still backtrack catastrophically),
    // which is why regex-mode matching itself runs on a worker below rather
    // than here.
    if (input.regex) {
      try {
        new RegExp(input.query, flags);
      } catch (error) {
        throw new Error(`Invalid regex "${input.query}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const needle = caseSensitive ? input.query : input.query.toLowerCase();

    const cm = this.cm as ContextManager;
    // The candidate window is the oldest (order:"oldest") or newest
    // (order:"newest", via edgeWindow — see there for why not an offset
    // tail) maxScan messages of the time/channel range. Oversize is
    // detected up front rather than
    // silently scanning maxScan candidates and returning as if that were the
    // whole window. See the tool description's `truncated` contract.
    if (maxScan === 0) throw new Error('"maxScan" must be at least 1 — a zero-message scan can never make progress.');
    // Continuation: `skipSequences` names what the previous call already
    // scanned at exactly the resume bound's millisecond (the bound is
    // inclusive). Identified by sequence range rather than a count, so a
    // message removed at that millisecond, or appended there (a new
    // message always gets the highest sequence), between calls neither
    // shifts the skip onto an unscanned message nor hides the new one.
    const skipRange = parseSkipSequences(input.skipSequences);
    const edgeMs = order === 'oldest' ? fromMs : toMs;
    if (skipRange && edgeMs === undefined) {
      throw new Error(`"skipSequences" only applies together with "${order === 'oldest' ? 'from' : 'to'}" — pass the whole \`resume\` object back.`);
    }
    const isSkipped = (m: StoredMessage) =>
      !!skipRange && m.timestamp.getTime() === edgeMs && m.sequence >= skipRange[0] && m.sequence <= skipRange[1];
    let windowMessages: StoredMessage[];
    let truncated: boolean;
    {
      // Over-fetch by the number of messages at the edge millisecond (the
      // only ones that can be skipped), then drop the skipped ones.
      const edgeTies = skipRange ? this.countAtMs(edgeMs!, channelId) : 0;
      const w = this.edgeWindow({ fromMs, toMs, channelId, n: maxScan + edgeTies, side: order });
      const pool = skipRange ? w.messages.filter((m) => !isSkipped(m)) : w.messages;
      truncated = w.more || pool.length > maxScan;
      windowMessages = pool.slice(0, maxScan);
    }
    const candidatePoolSize = windowMessages.length;
    const candidates = authorFilter ? windowMessages.filter(authorFilter) : windowMessages;
    const poolInfo = {
      candidatePoolSize,
      ...(authorFilter ? { afterAuthorFilter: candidates.length } : {}),
      order,
    };
    // Where the scan stopped, when it stopped before the end of the window
    // the caller asked about: either `limit` matches came first (the rest of
    // the pool was never looked at) or the pool itself was truncated. The
    // timestamp is the continuation point — from: (oldest) / to: (newest).
    // Boundary is inclusive, so a message at exactly that instant may repeat.
    const resumeInfo = (scanned: number): Record<string, unknown> => {
      const stoppedEarly = scanned < candidates.length;
      if (!stoppedEarly && !truncated) return {};
      // Stopped at limit: the last candidate actually looked at. Scanned the
      // whole (truncated) pool: the pool's own far edge — which may lie past
      // the last author-filtered candidate.
      const last = stoppedEarly ? candidates[scanned - 1] : windowMessages[windowMessages.length - 1];
      if (!last) return {};
      const at = last.timestamp.toISOString();
      const bound = order === 'oldest' ? 'from' : 'to';
      // The continuation bound is inclusive, so the next window starts with
      // every message at exactly `at`. Hand back the sequence range already
      // scanned there: this call's messages at `at` up to the stop, plus —
      // when `at` is still the incoming bound — the range the previous
      // call had already covered. Within one millisecond the pool is in
      // sequence order, so every message at `at` whose sequence lies in the
      // union was scanned; anything appended later sorts outside it.
      const atMs = last.timestamp.getTime();
      const stop = windowMessages.indexOf(last);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i <= stop; i++) {
        const m = windowMessages[i]!;
        if (m.timestamp.getTime() !== atMs) continue;
        lo = Math.min(lo, m.sequence);
        hi = Math.max(hi, m.sequence);
      }
      if (skipRange && atMs === edgeMs) {
        lo = Math.min(lo, skipRange[0]);
        hi = Math.max(hi, skipRange[1]);
      }
      const resume = { [bound]: at, skipSequences: [lo, hi] as [number, number] };
      return {
        scannedThrough: at,
        resume,
        hint:
          (stoppedEarly
            ? 'Stopped at limit; more candidates remain. '
            : `Only the ${order} ${candidatePoolSize} messages of this range were scanned (maxScan). `) +
          `Continue by repeating the call with the fields of \`resume\` (${bound}:"${at}" and skipSequences), ` +
          'or raise limit/maxScan, or narrow with channelId/author/dates.',
      };
    };

    if (input.regex) {
      // Regex matching against caller-supplied patterns is ReDoS-shaped: a
      // pathological pattern (e.g. `(a+)+$`) can take catastrophically long
      // against one candidate string, and a synchronous RegExp.exec() on
      // this thread would block the WHOLE framework's event loop — every
      // agent's turns, health checks, timers — for as long as it runs, with
      // no way to interrupt it from this same thread. Route matching
      // through a worker thread instead, which can be forcibly terminated
      // on a deadline. See search-regex-worker.ts's header for the full
      // rationale.
      const { matches, scanned } = await this.searchWithRegexWorker(candidates, input.query, flags, limit);
      return { success: true, data: { scanned, ...poolInfo, truncated, ...resumeInfo(scanned), matches } };
    }

    // Plain substring search (String.prototype.indexOf) is inherently
    // linear in input length — no ReDoS-equivalent risk — so it stays
    // in-process. This is also the common case, so it pays no worker-spawn
    // overhead.
    const matches: SearchMatch[] = [];
    let scanned = 0;
    for (const msg of candidates) {
      // Check the limit BEFORE doing any work for this candidate — not
      // after pushing a match — so limit:0 (a valid clampCount value: it's
      // >= 0) correctly yields zero matches instead of one. Checking
      // post-push would always let through the match that first reaches
      // the limit. Same fix mirrored in search-regex-worker.ts's loop.
      if (matches.length >= limit) break;
      scanned++;
      const text = flattenContent(msg.content);
      const hit = matchSubstring(text, needle, caseSensitive, input.wholeWord ?? false);
      if (!hit) continue;
      matches.push({
        id: String(msg.id),
        timestamp: msg.timestamp.toISOString(),
        participant: msg.participant,
        author: authorName(msg),
        channelId: getChannelId(msg) ?? null,
        snippet: snippetAround(text, hit.index, hit.length),
      });
    }

    return {
      success: true,
      data: { scanned, ...poolInfo, truncated, ...resumeInfo(scanned), matches },
    };
  }

  /**
   * Run regex matching for `search` on a worker thread with a hard
   * wall-clock deadline, so a catastrophically-backtracking pattern can be
   * forcibly killed instead of hanging the framework. One worker per call
   * (not per candidate — spawn overhead would dominate at scale; not a
   * persistent pool — a fresh worker per call means one bad pattern can
   * never contaminate a later search). Always terminated on the way out,
   * success or failure, so nothing lingers.
   *
   * On timeout or a worker-side error this THROWS (caught by
   * handleToolCall's try/catch, same as every other error path in this
   * module) rather than returning an empty match list — a timed-out search
   * must never be indistinguishable from a clean "no matches" result.
   */
  private async searchWithRegexWorker(
    candidates: StoredMessage[],
    pattern: string,
    flags: string,
    limit: number,
  ): Promise<{ matches: SearchMatch[]; scanned: number }> {
    const texts = candidates.map((msg) => flattenContent(msg.content));
    let worker: Worker | undefined;
    try {
      const { matches: rawMatches, scanned } = await new Promise<{ matches: SearchWorkerMatch[]; scanned: number }>(
        (resolve, reject) => {
          worker = new Worker(SEARCH_WORKER_PATH, { workerData: { texts, pattern, flags, limit } });
          const timer = setTimeout(() => {
            reject(
              new Error(
                `search timed out after ${SEARCH_REGEX_TIMEOUT_MS}ms while matching regex "${pattern}" against ` +
                  `up to ${texts.length} candidate(s) — the pattern may be catastrophically slow (exponential ` +
                  'backtracking) against this data; try a simpler pattern, a literal substring search ' +
                  '(regex:false), or a smaller maxScan.',
              ),
            );
          }, SEARCH_REGEX_TIMEOUT_MS);
          timer.unref?.();
          worker.once('message', (msg: SearchWorkerMessage) => {
            clearTimeout(timer);
            if (msg.type === 'error') reject(new Error(msg.error));
            else resolve({ matches: msg.matches, scanned: msg.scanned });
          });
          worker.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        },
      );

      const matches: SearchMatch[] = rawMatches.map(({ candidateIndex, matchIndex, matchLength }) => {
        const msg = candidates[candidateIndex]!;
        const text = texts[candidateIndex]!;
        return {
          id: String(msg.id),
          timestamp: msg.timestamp.toISOString(),
          participant: msg.participant,
          author: authorName(msg),
          channelId: getChannelId(msg) ?? null,
          snippet: snippetAround(text, matchIndex, matchLength),
        };
      });
      return { matches, scanned };
    } finally {
      // Always kill the worker — whether it finished, errored, or is still
      // stuck mid-backtrack when the deadline hit. terminate() on an
      // already-exited worker is a harmless no-op.
      if (worker) void worker.terminate().catch(() => {});
    }
  }

  // ==========================================================================
  // overview
  // ==========================================================================

  private async handleSemanticSearch(input: SemanticSearchInput): Promise<ToolResult> {
    if (!this.semanticCfg || !this.semanticClient) {
      throw new Error('semantic_search is not configured for this resident (no embed-service in the recipe).');
    }
    if (typeof input.query !== 'string' || !input.query.trim()) throw new Error('query must be a non-empty string');
    const limit = clampCount(input.limit, SEMANTIC_DEFAULT_LIMIT, SEMANTIC_MAX_LIMIT, 'limit');
    if (limit < 1) throw new Error('limit must be at least 1');
    const fromMs = parseIsoDate(input.from, 'from');
    const toMs = parseIsoDate(input.to, 'to');
    if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) throw new Error('`from` must not be after `to`');
    const channelId = this.resolveChannel(input.channelId);
    // Summaries carry no channel, so a channel filter on a summaries-only
    // search can only ever match nothing. Say so instead of returning [].
    const wantsSummariesOnly = input.level !== undefined || input.kinds === 'summaries';
    if (channelId && wantsSummariesOnly) {
      throw new Error('channelId cannot be combined with kinds="summaries" or level: summaries are not per-channel. Drop channelId, or search kinds="messages".');
    }
    if (input.level !== undefined && input.kinds === 'messages') {
      throw new Error('level applies to summaries only and cannot be combined with kinds="messages".');
    }
    let kinds: string[] | undefined;
    if (wantsSummariesOnly) kinds = ['summary'];
    else if (input.kinds === 'messages' || channelId) kinds = ['message'];
    if (input.level !== undefined && (!Number.isInteger(input.level) || input.level < 0)) throw new Error('level must be a non-negative integer');
    if (input.minScore !== undefined && (typeof input.minScore !== 'number' || input.minScore < -1 || input.minScore > 1)) {
      throw new Error('minScore must be a number in -1..1');
    }

    // Bounded catch-up so the newest messages are searchable; never block on a backlog.
    let sync: SyncReport | null = null;
    if (this.indexer) {
      try { sync = await this.indexer.catchUp(this.semanticCfg.maxSyncBeforeSearch ?? 256); } catch { /* reported via indexer.lastError */ }
    }

    const runSearch = (k: number) => this.semanticClient!.search({
      query: input.query, k,
      ts_from: fromMs === undefined ? undefined : fromMs / 1000,
      ts_to: toMs === undefined ? undefined : toMs / 1000,
      channel: channelId, kinds, level: input.level, min_score: input.minScore, snippet: SEMANTIC_SNIPPET_CHARS,
    });
    // The remote index is append-only and knows nothing about branches: a
    // message removed from the agent's reach by /undo, /checkout, /restore or
    // /newtopic keeps its id (a new message gets a fresh one) and stays
    // indexed. Check every hit against the CURRENT branch before it goes back
    // to the model — getMessage/getSummary rebuild on branch switch, so an
    // undone message or a summary minted on another branch answers null.
    // k is small, so this is at most `limit` local lookups.
    // A message hit whose current text has nothing left to index (edited
    // blank, delete not yet applied) is dropped too, so its stale snippet is
    // never served. Dropped hits are replaced by over-fetching: when the
    // top k held droppable entries, re-query with a larger k (service cap
    // 200) so lower-ranked on-branch matches still fill `limit`.
    const cm = this.cm as ContextManager;
    const includePrivate = this.semanticCfg.includePrivateTools ?? true;
    // A message hit's snippet is rebuilt from the CURRENT local text, never
    // the remote copy: an edit not yet synced (or one the index never got)
    // must not leak a passage the edit removed. Only the ranking can be stale.
    const currentText = new Map<string, string>();
    const keep = (h: { id: string }): 'ok' | 'offBranch' | 'stale' => {
      const msgId = /^msg:(.+)$/.exec(h.id)?.[1];
      const sumId = /^sum:(.+)$/.exec(h.id)?.[1];
      if (msgId !== undefined) {
        const m = cm.getMessage(msgId);
        if (!m) return 'offBranch';
        const text = messageIndexText(m, includePrivate).slice(0, this.semanticCfg!.maxChars ?? 32_000);
        if (!text) return 'stale';
        currentText.set(h.id, text);
        return 'ok';
      }
      if (sumId !== undefined) return cm.getSummary(sumId) !== null ? 'ok' : 'offBranch';
      return 'ok';
    };
    let k = limit;
    let res = await runSearch(k);
    let droppedOffBranch = 0;
    let droppedStale = 0;
    let onBranch: typeof res.hits = [];
    for (;;) {
      droppedOffBranch = 0; droppedStale = 0;
      onBranch = res.hits.filter((h) => {
        const v = keep(h);
        if (v === 'offBranch') droppedOffBranch++;
        else if (v === 'stale') droppedStale++;
        return v === 'ok';
      });
      if (onBranch.length >= limit || res.hits.length < k || k >= SEMANTIC_MAX_FETCH) break;
      k = Math.min(SEMANTIC_MAX_FETCH, k * 4);
      res = await runSearch(k);
    }
    onBranch = onBranch.slice(0, limit);
    const hits = onBranch.map((h) => ({
      id: h.id,
      /** Raw message id for a `msg:` hit (null for summaries) — pass it to extract({ aroundId }). */
      messageId: h.id.startsWith('msg:') ? h.id.slice(4) : null,
      kind: h.kind,
      level: h.level,
      score: h.score,
      timestamp: h.ts === null ? null : new Date(h.ts * 1000).toISOString(),
      channelId: h.channel,
      participant: (h.meta as { participant?: unknown }).participant ?? null,
      author: (h.meta as { author?: unknown }).author ?? null,
      snippet: currentText.has(h.id) ? snippetOf(currentText.get(h.id)!) : (h.text ?? ''),
      chars: currentText.has(h.id) ? currentText.get(h.id)!.length : h.chars,
    }));
    return {
      success: true,
      data: {
        hits,
        index: {
          indexed: res.count_indexed,
          behind: sync ? sync.more : this.indexer === null ? null : true,
          syncedThisCall: sync ? sync.pushed : 0,
          lastError: this.indexer?.lastError ?? null,
          /** Hits the index returned for messages/summaries not on the current branch (undone, checked out past). */
          droppedOffBranch,
          /** Hits for messages whose current text has nothing indexable (edited blank; the index delete is pending). */
          droppedStale,
        },
        timingMs: res.timing_ms,
      },
    };
  }

  private handleOverview(input: OverviewInput): ToolResult {
    const channelId = this.resolveChannel(input.channelId);
    const fromMs = parseIsoDate(input.from, 'from');
    const toMs = parseIsoDate(input.to, 'to');
    assertOrderedRange(fromMs, toMs, input.from, input.to);
    const limit = clampCount(input.limit, OVERVIEW_DEFAULT_LIMIT, OVERVIEW_MAX_LIMIT, 'limit');
    const cm = this.cm as ContextManager;

    let entries: TimeRangeSummaryEntry[];
    if (input.level !== undefined) {
      // Caller asked for one exact level: flat, no fold-reduction — they
      // want that granularity, not the coarsest-available mix below.
      entries = cm.getSummariesInRange({ fromMs, toMs, level: input.level });
    } else {
      // No level given: fetch every level overlapping the range, then
      // reduce to only "current" (non-superseded) entries. getSummariesInRange
      // does NOT filter by fold status — a folded child and the coarser
      // parent it was folded into can BOTH independently overlap the query
      // range and BOTH come back in `all` (see TimeRangeSummaryEntry.parentId's
      // doc comment in context-manager).
      //
      // Two complementary checks, because an ancestor CHAIN can be broken:
      // `listSummariesInRange` silently skips an entry whose source range no
      // longer resolves (a pruned/redacted source message, or a viewFilter
      // exclusion — a real, named failure mode elsewhere in
      // autobiographical.ts's contiguousMergeCandidates). If that skipped
      // entry is an INTERMEDIATE level, its children's parentId points at an
      // id that never made it into `all`, so the immediate-parent check
      // alone can't see past the gap and a since-superseded child survives
      // alongside the coarser grandparent that already covers its span.
      //  1. Immediate-parent check (cheap, covers the intact-chain case).
      //  2. Containment sweep (backstop, robust to a broken chain): drop an
      //     entry if any OTHER fetched entry is STRICTLY coarser (higher
      //     level) and its span fully contains this one — that entry
      //     already covers the same messages regardless of whether the
      //     parentId pointer chain between them survived intact.
      //     EXCEPTION: a zero-width entry (e.startMs === e.endMs — a tiny
      //     chunk that landed entirely within one millisecond) that merely
      //     TOUCHES a coarser entry's boundary at exactly that one point
      //     trivially satisfies "f.startMs <= e.startMs && f.endMs >=
      //     e.endMs" without f actually being an ancestor — a genuinely
      //     unrelated, later-starting/earlier-ending coarser summary can
      //     coincidentally share one endpoint with it. A real (non-zero-
      //     width) entry can't trigger this false positive: satisfying
      //     containment on BOTH ends while only touching at one means f
      //     must still genuinely extend past the entry's other, non-touching
      //     side. A genuine same-point fold is still caught by the
      //     immediate-parentId check above when the chain is intact.
      // O(n^2) in the fetched set size, which is fine at summary-archive
      // scale (bounded by how much has been compressed into this range, not
      // by raw message count).
      const all = cm.getSummariesInRange({ fromMs, toMs });
      const idsInSet = new Set(all.map((e) => e.id));
      entries = all.filter((e) => {
        if (e.parentId && idsInSet.has(e.parentId)) return false;
        return !all.some((f) => {
          if (f.id === e.id || f.level <= e.level) return false;
          if (!(f.startMs <= e.startMs && f.endMs >= e.endMs)) return false;
          if (e.startMs === e.endMs && (e.startMs === f.startMs || e.endMs === f.endMs)) return false;
          return true;
        });
      });
    }
    entries.sort((a, b) => a.startMs - b.startMs);

    // Per-summary channel/token stats — same call `stats` uses, scoped to
    // just this entry's own source span.
    const summarized: Array<{
      startMs: number;
      endMs: number;
      summarized: true;
      content: string;
      level: number;
      stats: ChannelTokenStats;
      boundaryUncertain?: boolean;
    }> = entries.map((entry) => ({
      startMs: entry.startMs,
      endMs: entry.endMs,
      summarized: true as const,
      content: entry.content,
      level: entry.level,
      stats: cm.getChannelTokenStats({ fromMs: entry.startMs, toMs: entry.endMs }),
    }));

    // Gap-fill: walk the sorted summary spans and probe seams wide enough
    // to be worth a getChannelTokenStats call. A gap with real traffic
    // becomes a synthetic summarized:false entry; an empty gap (nothing
    // happened there) is skipped rather than cluttering the response.
    //
    // Cursor anchoring when `from` is omitted: NOT "now" — with zero
    // summaries minted yet (first-ever call, or a PassthroughStrategy host
    // where getSummariesInRange always returns []) that would make the
    // whole walk a zero-width no-op and silently report entries:[] even
    // though the store is full of messages. And even WITH summaries
    // present, starting at the first summary's startMs silently hides any
    // older unsummarized traffic that predates every summary (e.g. history
    // from before compression was enabled). Anchor instead at the earlier
    // of "the first summary's start" and "the earliest real message in the
    // store" — falling back to Date.now() only when NEITHER exists, i.e.
    // the store is genuinely empty, where entries:[] is the correct answer.
    const rangeEnd = toMs ?? Date.now();
    const firstEntryStartMs = entries[0]?.startMs;
    let cursor: number;
    if (fromMs !== undefined) {
      cursor = fromMs;
    } else {
      const earliestMessageMs = this.earliestMessageMs(toMs);
      cursor =
        earliestMessageMs !== undefined && firstEntryStartMs !== undefined
          ? Math.min(earliestMessageMs, firstEntryStartMs)
          : earliestMessageMs ?? firstEntryStartMs ?? Date.now();
    }
    // Effective query start — captured BEFORE the gap loop below mutates
    // `cursor` (it walks forward past each entry's endMs). Needed by the
    // boundary-tie correction pass further down to clamp its output to
    // what the caller actually asked for (see the comment there): when
    // `fromMs` is omitted this equals the resolved anchor above, not
    // `-Infinity` — an open-ended query still has a concrete effective
    // start, it's just not caller-supplied.
    const rangeStart = cursor;

    const gaps: Array<{ startMs: number; endMs: number; summarized: false; stats: ChannelTokenStats; boundaryUncertain?: boolean }> = [];
    // True once `cursor` has been advanced past at least one real summary
    // entry's endMs — only THEN is `cursor` itself a value that a summary
    // already claims (and so needs a +1 nudge below to probe half-open).
    // The very first gap (before any entry) sits against `fromMs` or an
    // earliest-message anchor, neither of which any summary has claimed,
    // so it must NOT be nudged — nudging it would skip a real message
    // sitting exactly at the anchor.
    let cursorIsEntryBoundary = false;
    for (const entry of entries) {
      // getChannelTokenStats's range is BOTH-ENDS INCLUSIVE (chronicle's
      // gte/lte), so probing the raw [cursor, entry.startMs] pair would
      // re-count the neighboring summaries' own boundary messages (ts ===
      // cursor from the entry before, ts === entry.startMs from this one)
      // as if they were unsummarized — fabricating a phantom gap between
      // EVERY pair of adjacent summaries, even when they cover 100% of
      // traffic with zero real gap between them. Narrow to a half-open
      // probe instead, and only skip the call when narrowing collapsed the
      // width to zero or negative (`probeTo < probeFrom` — an entry that
      // starts exactly where the previous one ended, or crosses it).
      //
      // Deliberately NO minimum-width threshold beyond that: an earlier
      // version skipped any seam narrower than a fixed few seconds as
      // "bookkeeping noise", but that check ran BEFORE the
      // stats.totalMessages > 0 check below that actually decides whether
      // real traffic exists — so a query window or a between-summaries
      // seam narrower than the threshold silently reported entries:[] even
      // when full of real messages (verified repro: 300 real messages,
      // zero summaries, a 4-second window). The totalMessages > 0 check
      // that follows is the one that's actually correct; nothing should
      // gate the probe ahead of it.
      const probeFrom = cursorIsEntryBoundary ? cursor + 1 : cursor;
      const probeTo = entry.startMs - 1;
      if (probeTo >= probeFrom) {
        const stats = cm.getChannelTokenStats({ fromMs: probeFrom, toMs: probeTo });
        if (stats.totalMessages > 0) gaps.push({ startMs: probeFrom, endMs: probeTo, summarized: false, stats });
      }
      cursor = Math.max(cursor, entry.endMs);
      cursorIsEntryBoundary = true;
    }
    {
      // Trailing gap: rangeEnd is either the caller's own inclusive `to`
      // bound or Date.now() — never a summary boundary — so only the LOWER
      // end gets the half-open nudge (same reasoning as inside the loop).
      // Same no-threshold reasoning as above.
      const probeFrom = cursorIsEntryBoundary ? cursor + 1 : cursor;
      const probeTo = rangeEnd;
      if (probeTo >= probeFrom) {
        const stats = cm.getChannelTokenStats({ fromMs: probeFrom, toMs: probeTo });
        if (stats.totalMessages > 0) gaps.push({ startMs: probeFrom, endMs: probeTo, summarized: false, stats });
      }
    }

    // Boundary-tie disambiguation: getChannelTokenStats operates on
    // wall-clock TIME ranges and has no visibility into chronicle's
    // sequence numbers, so whenever a message that's genuinely NOT part of
    // a summary's source span happens to share the EXACT millisecond with
    // that summary's own first/last covered message (rapid-fire appends —
    // wall-clock ms resolution isn't unique, sequence is), the per-span
    // aggregate calls above silently fold it into the summary's counts —
    // and the adjacent gap probe (which deliberately EXCLUDES that same ms
    // via the half-open nudge, on the assumption the boundary ms belongs
    // entirely to the neighboring summary) has no way to see it at all: it
    // doesn't just get miscounted, it vanishes from the response entirely.
    //
    // Resolved using TimeRangeSummaryEntry's firstSequence/lastSequence
    // (chronicle's per-record sequence number — strictly monotonic, never
    // ties, unlike wall-clock ms) against the ACTUAL messages at each
    // boundary ms (queried directly via boundaryMessagesAt — cheap, at
    // most a handful of messages share one millisecond in practice).
    //
    // A "foreign" message found this way either belongs to ANOTHER fetched
    // summary entry (its sequence falls in THAT entry's own range — its
    // own inclusive-range getChannelTokenStats call already counts it
    // correctly, so this entry just needs the erroneous count subtracted,
    // nothing added elsewhere) or is genuinely unsummarized (belongs to the
    // adjacent gap, extending it — or creating a new point-width gap
    // fragment if no gap was probed there at all, which is exactly the
    // "vanishes entirely" failure mode this fix exists for).
    //
    // MESSAGE COUNT/membership is corrected exactly — we know precisely
    // which raw messages are foreign and their channelId. TOKEN weight for
    // those specific messages is deliberately NOT recomputed:
    // getChannelTokenStats can only report tokens for a TIME range, never
    // for an arbitrary message subset, and reimplementing token estimation
    // locally would silently drift from context-manager's own (mutable,
    // calibration-adjusted) estimate — worse than admitting the gap. Any
    // entry this pass touches is marked `boundaryUncertain: true` so a
    // caller knows its tokensEstimate may be off by the small, bounded
    // weight of the message(s) that moved, even though messageCount there
    // is exact.
    // Messages already routed into a gap by an EARLIER entry's pass in this
    // same loop — without this, two entries that both touch the same
    // boundary millisecond (e.g. summary A ends and summary B starts at the
    // exact same ms, with one genuinely-unsummarized stray message also at
    // that ms) each independently decide "not mine, not any other fetched
    // SUMMARY's either" and BOTH call mergeForeignIntoGap for the same
    // stray — mergeForeignIntoGap's own gap-lookup only checks for a gap
    // immediately adjacent to ITS OWN entry's boundary, so it can't see the
    // point-width gap the other entry's pass just created one step away,
    // and the same message gets double-counted into two separate gap
    // entries. Tracking ids already merged (not just already-seen) across
    // the whole loop — not just within one entry's own pass — closes this.
    const alreadyMergedForeignIds = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const own = summarized[i]!;
      // Defensive: firstSequence/lastSequence are new fields on
      // TimeRangeSummaryEntry (added alongside this correction pass) — if
      // this module ever ends up running against an OLDER published
      // context-manager whose getSummariesInRange doesn't populate them
      // (undefined, not a type error at runtime), every comparison below
      // would silently evaluate false, foreignById would always be empty,
      // and this whole pass would silently no-op — resurrecting the exact
      // boundary-tie bug it exists to fix, with no error and no
      // boundaryUncertain signal. Skip explicitly instead of trusting the
      // type system alone.
      if (typeof entry.firstSequence !== 'number' || typeof entry.lastSequence !== 'number') continue;
      const boundaryMsList = entry.startMs === entry.endMs ? [entry.startMs] : [entry.startMs, entry.endMs];
      const foreignById = new Map<string, StoredMessage>();
      for (const ms of boundaryMsList) {
        for (const m of this.boundaryMessagesAt(ms)) {
          if (m.sequence < entry.firstSequence || m.sequence > entry.lastSequence) {
            foreignById.set(String(m.id), m);
          }
        }
      }
      if (foreignById.size === 0) continue;

      const genuinelyUnsummarized: StoredMessage[] = [];
      for (const m of foreignById.values()) {
        const owner = entries.find(
          (e) =>
            e.id !== entry.id &&
            typeof e.firstSequence === 'number' &&
            typeof e.lastSequence === 'number' &&
            m.sequence >= e.firstSequence &&
            m.sequence <= e.lastSequence,
        );
        if (!owner && !alreadyMergedForeignIds.has(String(m.id))) genuinelyUnsummarized.push(m);
      }

      own.stats = subtractMessagesFromStats(own.stats, [...foreignById.values()]);
      own.boundaryUncertain = true;

      // getSummariesInRange intentionally returns WHOLE summaries that
      // overlap the query — a summary's own startMs/endMs can legitimately
      // extend past the caller's requested [rangeStart, rangeEnd] (that's
      // correct: the summary itself, and its corrected messageCount above,
      // belong in the response either way). But a correction-pass GAP
      // anchored at entry.startMs/entry.endMs must NOT be added when that
      // boundary itself falls outside the query window — the ordinary gap
      // walk elsewhere in this function never synthesizes a gap outside
      // [rangeStart, rangeEnd], and this pass shouldn't either. Without
      // this check, a narrow-window query landing entirely inside an
      // already-summarized span could still surface phantom
      // summarized:false rows anchored at that summary's FAR boundaries,
      // outside anything the caller asked about.
      const before = genuinelyUnsummarized.filter((m) => m.sequence < entry.firstSequence);
      const after = genuinelyUnsummarized.filter((m) => m.sequence > entry.lastSequence);
      const startInRange = entry.startMs >= rangeStart && entry.startMs <= rangeEnd;
      const endInRange = entry.endMs >= rangeStart && entry.endMs <= rangeEnd;
      if (before.length > 0 && startInRange) {
        mergeForeignIntoGap(gaps, entry.startMs, 'before', before);
        for (const m of before) alreadyMergedForeignIds.add(String(m.id));
      }
      if (after.length > 0 && endInRange) {
        mergeForeignIntoGap(gaps, entry.endMs, 'after', after);
        for (const m of after) alreadyMergedForeignIds.add(String(m.id));
      }
    }

    // Merge summary-backed + gap-filled spans, apply the channel filter
    // (drop any span with zero messages from the requested channel — but
    // keep a kept summary's `content` unfiltered: compression doesn't chunk
    // per-channel, so the text may legitimately describe other channels
    // too), sort, and project to the response shape.
    const merged = [...summarized, ...gaps].sort((a, b) => a.startMs - b.startMs);
    const filtered = channelId
      ? merged.filter((e) => e.stats.byChannel.some((c) => c.channelId === channelId))
      : merged;

    // Cap the final entry list — mirrors search's truncated:true contract.
    // Keeps the MOST RECENT `limit` spans when the cap is hit (a browse
    // tool defaulting to "what's happened lately" should keep the tail, not
    // silently cut off at the oldest end) while the survivors stay in their
    // own chronological (oldest-first) order within the response, matching
    // extract's/search's own ordering convention.
    const totalSpans = filtered.length;
    const truncated = totalSpans > limit;
    // NOT `filtered.slice(-limit)`: `slice(-0)` is `slice(+0)` (negative
    // zero coerces away), so `limit: 0` — a value clampCount explicitly
    // accepts — would slice from index 0 and return the ENTIRE array while
    // still reporting truncated:true. Same bug class already fixed twice
    // elsewhere in this project (search's/extract's own limit:0 bugs);
    // `filtered.length - limit` has no such cliff, at limit:0 it's
    // `slice(filtered.length)` -> `[]`, the honest answer.
    const capped = truncated ? filtered.slice(filtered.length - limit) : filtered;

    return {
      success: true,
      data: {
        range: { from: input.from ?? null, to: input.to ?? null },
        // Only meaningful as a single number when `level` was pinned: the
        // default (fold-reduced) result mixes spans at whatever level each
        // one's own coarsest-available summary happens to be, so reporting
        // a single `level` there would be actively misleading (an agent
        // could see level:3 while looking at an L1 entry). Each summarized
        // entry already carries its own accurate `level`; the top-level
        // field instead reports the ceiling as `maxLevelAvailable` in that
        // case, distinctly named so it can't be mistaken for a uniform
        // per-entry level.
        ...(input.level !== undefined ? { level: input.level } : { maxLevelAvailable: cm.getMaxSummaryLevel() }),
        truncated,
        totalSpans,
        entries: capped.map((e) => {
          // When channelId narrows the response, the numbers an agent will
          // actually reason over (messageCount/tokensEstimate) are scoped
          // to THAT channel — not the whole span, which can otherwise
          // include far more traffic from other channels sharing the same
          // summarized/gap span. This is a deliberate departure from
          // `stats`, which keeps its top-level totals whole-range and only
          // narrows the byChannel breakdown (documented in handleStats) —
          // here, an agent that asked to narrow by channel is reasoning
          // about that channel specifically, so the whole-span totals stay
          // available under distinctly-named spanMessageCount/
          // spanTokensEstimate instead of silently double-serving as both.
          const channelStats = channelId ? e.stats.byChannel.find((c) => c.channelId === channelId) : undefined;
          return {
            from: new Date(e.startMs).toISOString(),
            to: new Date(e.endMs).toISOString(),
            summarized: e.summarized,
            ...(e.summarized ? { content: e.content, level: e.level } : {}),
            // Set only when this entry's boundary-tie disambiguation (see
            // the correction pass above) found and corrected a
            // millisecond-timestamp collision at its edge. messageCount is
            // still exact there; tokensEstimate may be off by the small,
            // bounded weight of the message(s) that moved.
            ...(e.boundaryUncertain ? { boundaryUncertain: true } : {}),
            messageCount: channelStats ? channelStats.messages : e.stats.totalMessages,
            tokensEstimate: channelStats ? channelStats.tokensEstimate : e.stats.totalTokensEstimate,
            ...(channelId ? { spanMessageCount: e.stats.totalMessages, spanTokensEstimate: e.stats.totalTokensEstimate } : {}),
            byChannel: e.stats.byChannel,
          };
        }),
      },
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Parse an ISO 8601 date string to Unix ms. Throws a clear error (not a
 *  crash) on an unparseable string; returns undefined for an omitted field
 *  (open-ended bound). */
function parseIsoDate(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO 8601 date for "${field}": ${JSON.stringify(value)}`);
  }
  return ms;
}

/**
 * Reject an inverted range (`from` after `to`) with a clear error instead of
 * silently matching nothing. Used by `overview`, where "found nothing" is
 * reported as `entries: []` — the same shape a caller sees for a genuinely
 * quiet span — so a simple from/to mixup should never be allowed to look
 * like "you have no history here" instead of the input mistake it is.
 */
function assertOrderedRange(fromMs: number | undefined, toMs: number | undefined, fromRaw: string | undefined, toRaw: string | undefined): void {
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    throw new Error(`"from" (${fromRaw}) must not be after "to" (${toRaw}).`);
  }
}

/**
 * Validate a pagination-ish numeric input (limit/offset/maxScan) and clamp
 * it to an upper bound. `Math.min(value, max)` alone is NOT sufficient here:
 * it only enforces an upper bound, so `Math.min(-1, 200)` is `-1`, not a
 * sane value — a negative limit/offset/maxScan would sail straight past the
 * "hard cap" and reach a native chronicle call expecting an unsigned
 * pagination argument (observed: `extract({limit:-1})` returning every
 * message in the store instead of being capped). Rejects (rather than
 * silently clamping) anything that isn't a finite non-negative integer, so
 * a caller mistake is surfaced as a clean tool error instead of silently
 * doing something other than what was asked.
 */
function clampCount(value: number | undefined, def: number, max: number, field: string): number {
  if (value === undefined) return def;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`"${field}" must be a finite number, got ${JSON.stringify(value)}.`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`"${field}" must be an integer, got ${value}.`);
  }
  if (value < 0) {
    throw new Error(`"${field}" must be >= 0, got ${value}.`);
  }
  return Math.min(value, max);
}

/** channelId lives at metadata.external.channelId — same path context-manager's
 *  own native index reads from (message-store.ts's CHANNEL_FIELD). Metadata's
 *  index-signature type means this needs an explicit narrow, same as
 *  MessageStore.getChannelTokenStats does internally. */
/**
 * Two channel-id metadata shapes exist in the wild: `metadata.channelId`
 * (what agent-framework's real MCPL ingestion — `handleMcplChannelIncoming`
 * — actually writes) and `metadata.external.channelId` (an older
 * convention). context-manager 0.9.1+ indexes and queries BOTH (see
 * MessageStore.extractChannelId there), so a channel-filtered result can
 * come from either shape — check the same order here so a displayed
 * `channelId` never reads `null` on a message that was, in fact, matched by
 * channel.
 */
function getChannelId(msg: StoredMessage): string | undefined {
  const metadata = msg.metadata as { channelId?: unknown; external?: { channelId?: unknown } } | undefined;
  if (typeof metadata?.channelId === 'string') return metadata.channelId;
  return typeof metadata?.external?.channelId === 'string' ? metadata.external.channelId : undefined;
}

// ============================================================================
// overview: boundary-tie correction helpers (see handleOverview)
// ============================================================================

/**
 * Subtract the exact per-channel MESSAGE COUNT of `foreign` from `stats` —
 * used to correct a summary entry's own stats once boundary-tie
 * disambiguation finds messages counted in error (see handleOverview's
 * correction pass). Deliberately leaves totalTokensEstimate/
 * byChannel[].tokensEstimate untouched — see that pass's header comment
 * for why an exact token subtraction isn't achievable from the available
 * API.
 */
function subtractMessagesFromStats(stats: ChannelTokenStats, foreign: StoredMessage[]): ChannelTokenStats {
  if (foreign.length === 0) return stats;
  const countByChannel = new Map<string, number>();
  for (const m of foreign) {
    const ch = getChannelId(m);
    if (ch === undefined) continue; // unchanneled messages aren't tracked in byChannel at all
    countByChannel.set(ch, (countByChannel.get(ch) ?? 0) + 1);
  }
  const byChannel = stats.byChannel
    .map((c) => ({ ...c, messages: Math.max(0, c.messages - (countByChannel.get(c.channelId) ?? 0)) }))
    .filter((c) => c.messages > 0);
  return {
    totalMessages: Math.max(0, stats.totalMessages - foreign.length),
    totalTokensEstimate: stats.totalTokensEstimate,
    byChannel,
  };
}

/**
 * Exact per-channel MESSAGE COUNT for a small raw message list, with
 * tokensEstimate left at 0 (unknown — see handleOverview's boundary-tie
 * correction pass). Only ever used to build a BRAND NEW synthetic gap
 * fragment out of boundary-tie foreign messages — a real query result
 * always goes through the real getChannelTokenStats aggregate instead.
 */
function statsFromMessages(messages: StoredMessage[]): ChannelTokenStats {
  const byChannel = new Map<string, number>();
  for (const m of messages) {
    const ch = getChannelId(m);
    if (ch === undefined) continue;
    byChannel.set(ch, (byChannel.get(ch) ?? 0) + 1);
  }
  return {
    totalMessages: messages.length,
    totalTokensEstimate: 0,
    byChannel: [...byChannel.entries()].map(([channelId, count]) => ({ channelId, messages: count, tokensEstimate: 0 })),
  };
}

/** Add `b`'s counts into `a` — used to fold boundary-tie foreign messages
 *  into an already-probed gap's stats. */
function mergeStats(a: ChannelTokenStats, b: ChannelTokenStats): ChannelTokenStats {
  const byChannel = new Map<string, { messages: number; tokensEstimate: number }>();
  for (const c of a.byChannel) byChannel.set(c.channelId, { messages: c.messages, tokensEstimate: c.tokensEstimate });
  for (const c of b.byChannel) {
    const cur = byChannel.get(c.channelId) ?? { messages: 0, tokensEstimate: 0 };
    cur.messages += c.messages;
    cur.tokensEstimate += c.tokensEstimate;
    byChannel.set(c.channelId, cur);
  }
  return {
    totalMessages: a.totalMessages + b.totalMessages,
    totalTokensEstimate: a.totalTokensEstimate + b.totalTokensEstimate,
    byChannel: [...byChannel.entries()].map(([channelId, v]) => ({ channelId, ...v })),
  };
}

/**
 * Fold boundary-tie `foreign` messages into whichever gap sits immediately
 * `side` of `boundaryMs`, extending that gap's span to include the tied
 * millisecond — or, if no such gap currently exists (the common case when
 * the seam had zero OTHER real traffic and so was never probed into
 * existence), create a new point-width gap fragment exactly at
 * `boundaryMs` to hold them. Always marks the result `boundaryUncertain:
 * true` (see handleOverview's boundary-tie correction pass for what that
 * means).
 */
function mergeForeignIntoGap(
  gaps: Array<{ startMs: number; endMs: number; summarized: false; stats: ChannelTokenStats; boundaryUncertain?: boolean }>,
  boundaryMs: number,
  side: 'before' | 'after',
  foreign: StoredMessage[],
): void {
  const addend = statsFromMessages(foreign);
  const existing =
    side === 'before' ? gaps.find((g) => g.endMs === boundaryMs - 1) : gaps.find((g) => g.startMs === boundaryMs + 1);

  if (existing) {
    existing.stats = mergeStats(existing.stats, addend);
    if (side === 'before') existing.endMs = boundaryMs;
    else existing.startMs = boundaryMs;
    existing.boundaryUncertain = true;
  } else {
    gaps.push({ startMs: boundaryMs, endMs: boundaryMs, summarized: false, stats: addend, boundaryUncertain: true });
  }
}

function projectMessage(msg: StoredMessage, format: 'text' | 'raw'): Record<string, unknown> {
  return {
    id: String(msg.id),
    timestamp: msg.timestamp.toISOString(),
    participant: msg.participant,
    author: authorName(msg),
    channelId: getChannelId(msg) ?? null,
    content: format === 'raw' ? msg.content : flattenContent(msg.content),
  };
}

/** Flatten a message's content blocks to one short, readable string. Text
 *  blocks verbatim; everything else (tool_use/tool_result/thinking/media) as
 *  a short bracketed label — this is for agent readability and search
 *  matching, not byte-faithful reconstruction. */
function flattenContent(content: ContentBlock[]): string {
  return content.map(blockLabel).join(' ').trim();
}

function blockLabel(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'tool_use':
      return `[tool_use: ${block.name}]`;
    case 'tool_result':
      return block.toolName ? `[tool_result: ${block.toolName}]` : '[tool_result]';
    case 'thinking':
    case 'redacted_thinking':
      return '[thinking]';
    case 'image':
      return '[image]';
    case 'generated_image':
      return '[image]';
    case 'document':
      return '[document]';
    case 'audio':
      return '[audio]';
    case 'video':
      return '[video]';
    default:
      // Exhaustiveness guard: a future ContentBlock variant falls back to a
      // generic label instead of a compile error at a call site far from here.
      return `[${(block as { type: string }).type}]`;
  }
}

interface MatchHit {
  index: number;
  length: number;
}

/** One `search` result entry — shared shape between the in-process substring
 *  path and the worker-backed regex path. */
interface SearchMatch {
  id: string;
  timestamp: string;
  participant: string;
  /** Display name from metadata.author (null when absent — e.g. the agent's own turns; see participant). */
  author: string | null;
  channelId: string | null;
  snippet: string;
}

/** Letters, combining marks (NFD accents, Indic vowel signs), digits, underscore. */
const WORD_CHAR_RE = /[\p{L}\p{M}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR_RE.test(ch);
}

/** The whole code point starting at `i` (astral letters are two UTF-16 units). */
function codePointAt(s: string, i: number): string | undefined {
  const cp = s.codePointAt(i);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/** The whole code point ending just before `i`. */
function codePointBefore(s: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

/**
 * First occurrence of `needle` in `text`. With `wholeWord`, an occurrence
 * only counts when it isn't glued to a letter/digit/underscore on either
 * side (Unicode-aware, so Cyrillic words work too) — "mission" no longer
 * hits inside "uncommissioned". Word-ness is checked only on the sides
 * where the needle itself starts/ends with a word character, so a needle
 * like "#general" or "v2." still matches the way a person would expect.
 */
function matchSubstring(text: string, needle: string, caseSensitive: boolean, wholeWord = false): MatchHit | null {
  const haystack = caseSensitive ? text : text.toLowerCase();
  if (!wholeWord) {
    const index = haystack.indexOf(needle);
    return index === -1 ? null : { index, length: needle.length };
  }
  const checkLeft = isWordChar(codePointAt(needle, 0));
  const checkRight = isWordChar(codePointBefore(needle, needle.length));
  for (let from = 0; ; ) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return null;
    const end = index + needle.length;
    if ((!checkLeft || !isWordChar(codePointBefore(haystack, index))) && (!checkRight || !isWordChar(codePointAt(haystack, end)))) {
      return { index, length: needle.length };
    }
    from = index + 1;
  }
}

// ============================================================================
// author filtering
// ============================================================================

/** metadata.author as written by MCPL channel ingestion ({id, name}). Every
 *  incoming channel message is stored with participant "user" — the real
 *  author lives only here. */
function authorOf(msg: StoredMessage): { id?: string; name?: string } | undefined {
  const a = (msg.metadata as { author?: unknown } | undefined)?.author;
  if (!a || typeof a !== 'object') return undefined;
  const { id, name } = a as { id?: unknown; name?: unknown };
  return {
    ...(typeof id === 'string' || typeof id === 'number' ? { id: String(id) } : {}),
    ...(typeof name === 'string' ? { name } : {}),
  };
}

function parseSkipSequences(v: unknown): [number, number] | null {
  if (v === undefined || v === null) return null;
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    !v.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0) ||
    v[0] > v[1]
  ) {
    throw new Error('"skipSequences" must be [lo, hi], two non-negative integers with lo <= hi — copy it from `resume`.');
  }
  return [v[0], v[1]];
}

function idOrNull(msg: StoredMessage | undefined): string | null {
  return msg ? String(msg.id) : null;
}

function authorName(msg: StoredMessage): string | null {
  return authorOf(msg)?.name ?? null;
}

/** Normalize one author spec: trim, case-fold, strip a leading "@", unwrap a
 *  <@id>/<@!id> mention to its id. */
function normalizeAuthorSpec(spec: string): string {
  const s = spec.trim();
  const mention = /^<@!?([^\s<>@]+)>$/.exec(s);
  if (mention) return mention[1]!.toLowerCase();
  return s.replace(/^@/, '').toLowerCase();
}

function toAuthorSet(spec: AuthorSpec | undefined, field: string): Set<string> | null {
  if (spec === undefined) return null;
  const list = Array.isArray(spec) ? spec : [spec];
  if (list.some((s) => typeof s !== 'string')) {
    throw new Error(`"${field}" must be a string or an array of strings.`);
  }
  const set = new Set(list.map(normalizeAuthorSpec).filter((s) => s.length > 0));
  if (set.size === 0) throw new Error(`"${field}" must name at least one author.`);
  return set;
}

/**
 * Predicate for `author`/`excludeAuthor`, or null when neither is given.
 * A message's identities are its metadata.author name and id plus its
 * stored participant — the last is what identifies the agent's own turns
 * (and anything else ingested without author metadata). Exact match after
 * normalization, never substring: "ann" must not pull in "joanne".
 */
function buildAuthorFilter(include: AuthorSpec | undefined, exclude: AuthorSpec | undefined): ((m: StoredMessage) => boolean) | null {
  const inc = toAuthorSet(include, 'author');
  const exc = toAuthorSet(exclude, 'excludeAuthor');
  if (!inc && !exc) return null;
  return (m) => {
    const a = authorOf(m);
    // participant only for messages WITHOUT author metadata (the agent's own
    // turns): every MCPL-ingested message has participant "user", which
    // would otherwise make author:"user" match everyone.
    const keys = (a ? [a.name?.toLowerCase(), a.id?.toLowerCase()] : [m.participant?.toLowerCase()]).filter(
      (k): k is string => !!k,
    );
    if (inc && !keys.some((k) => inc.has(k))) return false;
    if (exc && keys.some((k) => exc.has(k))) return false;
    return true;
  };
}

/** ~SNIPPET_CONTEXT_CHARS of surrounding context on each side of a match, or
 *  the first ~SNIPPET_FALLBACK_CHARS of content when no meaningful match
 *  position is given (kept simple on purpose — this is a readability aid,
 *  not a highlighting engine). */
function snippetAround(text: string, index: number, length: number): string {
  if (index < 0) return text.slice(0, SNIPPET_FALLBACK_CHARS);
  const start = Math.max(0, index - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(text.length, index + length + SNIPPET_CONTEXT_CHARS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end) + suffix;
}

/**
 * Request-only rows: user turns a request carries before a stored response
 * that the store never holds, rendered again by every later compile.
 *
 * Two kinds exist, and both are anchored to the response they prompted:
 *
 * - A silent heartbeat tick stores no prompt row (#216): its reply is written
 *   straight after whatever the window held before it — often the previous
 *   assistant message, since a suppressed tick leaves no delivery receipt
 *   behind. Every row a tick writes is stamped with `metadata.silentHeartbeat`,
 *   and a separator carrying the tick's instruction is rendered before the
 *   first of the tick's rows that survives compilation.
 * - A compile that ends on the agent's own message gets a trailing
 *   `[Continue]` turn (some models reject a trailing assistant message). The
 *   reply it prompts is stored straight after that message, so every row the
 *   reply's turn stores is stamped `metadata.promptedBy` (`RequestOnlyPrompt`),
 *   and the turn is rendered before the first of them that survives.
 *
 * Without the row, the wire formatter merges consecutive same-role messages:
 * the reply would read as an unprompted continuation of the earlier response,
 * and one assistant message would carry signed thinking from two separate
 * responses (a provider 400 when it is the latest assistant message; see
 * `Agent.addAssistantResponse`). And the request that minted the reply held
 * the row: a provider that binds signed thinking to the prefix it was minted
 * under (context-manager #155) refuses that thinking once a later request
 * drops it. Each row's text is read from the stamp (what the request that
 * minted the reply rendered, so a later change to the constant changes no
 * stored reply's prefix) and its position is a function of the stamped rows
 * alone, so every compile renders it in the same place (the request that
 * minted the reply ends on that same turn), which keeps the prompt-cache
 * prefix and the binding stable — unlike a per-compile injection that
 * re-anchors to the newest user message, or a system prompt that changes for
 * one turn.
 *
 * Known limit: compiled messages carry no store provenance, so a stored row
 * is recognised only by structural identity the provider made unique
 * (tool_use ids, thinking signatures). A reply with neither — unsigned and
 * tool-free — gets no row and still merges as before. Without signed thinking
 * that merge carries no provider-rejection risk; it is only a misreading.
 * Reply text is deliberately never used as identity: identical replies ("all
 * quiet") would collide, and an ordinary reply with the same text could take
 * another reply's row and rewrite cached history. Exact matching for every
 * row would need the compile result to expose each message's source rows.
 */
import type { ContentBlock, NormalizedMessage } from '@animalabs/membrane';

/** Request-only separator a silent tick's request ends on. It carries the
 * tick's instruction, so the tick's own request reads it as its prompt, and
 * every later compile renders it again before the tick's first surviving row.
 * Constant on purpose: it carries no time or id. Each tick's rows record the
 * text their request rendered (`SilentHeartbeatStamp.separator`), so changing
 * this constant changes only ticks that open afterwards. */
export const SILENT_HEARTBEAT_SEPARATOR =
  '[silent heartbeat] Scheduled private self-check. Review pending matters privately. ' +
  'Do not narrate or publish plain prose; use an explicit send tool only if you deliberately choose to contact someone.';

/** The separator ticks rendered before their rows recorded its text: rows
 * stamped without `separator` still render it, byte for byte. */
const LEGACY_SILENT_HEARTBEAT_SEPARATOR = '[heartbeat tick]';

/** Request-only turn a compile that ends on the agent's own message gets. */
export const CONTINUE_ROW = '[Continue]';

/** Identity of one authenticated silent heartbeat tick. */
export interface SilentHeartbeatTick {
  /** The MCPL push event that woke the tick. A broadcast tick reaches every
   * resident with the same id. */
  eventId: string;
  /** The MCPL server that sent it. */
  serverId: string;
}

/** `metadata.silentHeartbeat` on every row a tick's turn writes. Residents
 * share one message slot, so the stamp names the agent whose turn wrote it
 * (tool_result rows are stored as `user`). */
export interface SilentHeartbeatStamp extends SilentHeartbeatTick {
  agentName: string;
  /** The separator text the tick's request rendered, which later compiles
   * render again. Absent on rows stamped before it was recorded; they render
   * the bare marker those requests carried. */
  separator?: string;
}

/** The tick stamp on a stored row's metadata, if any. */
export function silentHeartbeatOf(metadata: unknown): SilentHeartbeatStamp | undefined {
  const stamp = (metadata as { silentHeartbeat?: unknown } | undefined)?.silentHeartbeat;
  if (!stamp || typeof stamp !== 'object') return undefined;
  const { eventId, serverId, agentName, separator } = stamp as Record<string, unknown>;
  return typeof eventId === 'string' && typeof serverId === 'string' && typeof agentName === 'string'
    ? { eventId, serverId, agentName, ...(typeof separator === 'string' ? { separator } : {}) }
    : undefined;
}

/** A request-only turn a request ended on before the agent's reply, as
 * `metadata.promptedBy` on every row the reply's turn stores: `turn` names
 * the one prompt, and `text` is what the request rendered. */
export interface RequestOnlyPrompt {
  turn: string;
  text: string;
}

/** The request-only prompt a stored row replies to, if any. */
export function promptedByOf(metadata: unknown): RequestOnlyPrompt | undefined {
  const prompt = (metadata as { promptedBy?: unknown } | undefined)?.promptedBy;
  if (!prompt || typeof prompt !== 'object') return undefined;
  const { turn, text } = prompt as Record<string, unknown>;
  return typeof turn === 'string' && typeof text === 'string' ? { turn, text } : undefined;
}

export function silentHeartbeatSeparatorTurn(): NormalizedMessage {
  return requestOnlyTurn(SILENT_HEARTBEAT_SEPARATOR);
}

export function continueTurn(): NormalizedMessage {
  return requestOnlyTurn(CONTINUE_ROW);
}

function requestOnlyTurn(text: string): NormalizedMessage {
  return { participant: 'user', content: [{ type: 'text', text }] };
}

/**
 * Structural identity of one stored response wherever a compile renders it:
 * tool_use ids and thinking signatures, which the provider made unique and
 * strategies keep verbatim (the same identity the tool-result guard relies
 * on). Text is never read, so request-build sanitizing (blank text blocks
 * stripped) cannot make a stored row and its compiled copy disagree.
 */
function identityKeys(content: ContentBlock[]): string[] {
  const keys: string[] = [];
  for (const block of content) {
    if (block.type === 'tool_use' && typeof block.id === 'string' && block.id) keys.push(`tool_use:${block.id}`);
    else if (block.type === 'thinking' && typeof block.signature === 'string' && block.signature) {
      keys.push(`thinking:${block.signature}`);
    } else if (block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data) {
      keys.push(`redacted:${block.data}`);
    }
  }
  return keys;
}

export interface StoredRowLike {
  participant: string;
  content: ContentBlock[];
  metadata?: unknown;
}

export interface RequestOnlyRowIndex {
  /** Identity key of every assistant row this agent stored during a silent
   *  tick → the tick, and the separator text to render before its first
   *  surviving row. */
  ticks: Map<string, { eventId: string; text: string }>;
  /** Identity key of every assistant row this agent stored in reply to a
   *  request-only prompt → that prompt. */
  prompts: Map<string, RequestOnlyPrompt>;
}

/** Index the agent's own rows that follow request-only turns: the rows of its
 * silent ticks, and the rows of each reply to a `[Continue]`. The two are
 * independent, so a row can be both. */
export function indexRequestOnlyRows(stored: readonly StoredRowLike[], agentName: string): RequestOnlyRowIndex {
  const ticks = new Map<string, { eventId: string; text: string }>();
  const prompts = new Map<string, RequestOnlyPrompt>();
  for (const row of stored) {
    if (row.participant !== agentName) continue;
    const keys = identityKeys(row.content);
    if (keys.length === 0) continue;
    const stamp = silentHeartbeatOf(row.metadata);
    if (stamp && stamp.agentName === agentName) {
      const tick = { eventId: stamp.eventId, text: stamp.separator ?? LEGACY_SILENT_HEARTBEAT_SEPARATOR };
      for (const key of keys) ticks.set(key, tick);
    }
    const prompt = promptedByOf(row.metadata);
    if (prompt) for (const key of keys) prompts.set(key, prompt);
  }
  return { ticks, prompts };
}

export interface RenderedRequestOnlyRows {
  messages: NormalizedMessage[];
  /** The ticks whose separator this window renders. A tick none of whose
   *  rows survive compilation renders none. */
  separatedTicks: Set<string>;
  /** The prompts (`RequestOnlyPrompt.turn`) this window renders, the same
   *  way. */
  promptedTurns: Set<string>;
}

/**
 * Insert the request-only turns into a compiled window, each immediately
 * before the first of its rows that survives compilation (the first row when
 * it is rendered, otherwise whichever later row a strategy kept): a tick's
 * separator, and the prompt each reply to `[Continue]` followed, after any
 * separator, as the reply's request had them. Rows folded into summaries
 * simply do not match; ordinary messages pass through untouched.
 */
export function renderRequestOnlyRows(
  messages: NormalizedMessage[],
  index: RequestOnlyRowIndex,
  agentName: string,
): RenderedRequestOnlyRows {
  const separatedTicks = new Set<string>();
  const promptedTurns = new Set<string>();
  if (index.ticks.size === 0 && index.prompts.size === 0) return { messages, separatedTicks, promptedTurns };
  const out: NormalizedMessage[] = [];
  for (const message of messages) {
    if (message.participant === agentName) {
      const keys = identityKeys(message.content);
      const tick = keys.map((key) => index.ticks.get(key)).find((t) => t !== undefined);
      if (tick !== undefined && !separatedTicks.has(tick.eventId)) {
        separatedTicks.add(tick.eventId);
        out.push(requestOnlyTurn(tick.text));
      }
      const prompt = keys.map((key) => index.prompts.get(key)).find((p) => p !== undefined);
      if (prompt !== undefined && !promptedTurns.has(prompt.turn)) {
        promptedTurns.add(prompt.turn);
        out.push(requestOnlyTurn(prompt.text));
      }
    }
    out.push(message);
  }
  return { messages: out, separatedTicks, promptedTurns };
}

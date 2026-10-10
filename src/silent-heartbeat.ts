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
 *   reply it prompts is stored straight after that message, so the reply's
 *   first stored row is stamped `metadata.promptedBy: 'continue'`, and the
 *   `[Continue]` turn is rendered before it.
 *
 * Without the row, the wire formatter merges consecutive same-role messages:
 * the reply would read as an unprompted continuation of the earlier response,
 * and one assistant message would carry signed thinking from two separate
 * responses (a provider 400 when it is the latest assistant message; see
 * `Agent.addAssistantResponse`). And the request that minted the reply held
 * the row: a provider that binds signed thinking to the prefix it was minted
 * under (context-manager #155) refuses that thinking once a later request
 * drops it. Each row's text is constant and its position is a function of the
 * stamped rows alone, so every compile renders it in the same place (the
 * request that minted the reply ends on that same turn), which keeps the
 * prompt-cache prefix and the binding stable — unlike a per-compile injection
 * that re-anchors to the newest user message, or a system prompt that changes
 * for one turn.
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

/** Request-only separator before a silent tick's first surviving row. It
 * carries the tick's instruction, so the tick's own request reads it as its
 * prompt and every later compile shows it at each past tick. Constant on
 * purpose: it carries no time or id, so it is byte-identical on every
 * compile. */
export const SILENT_HEARTBEAT_SEPARATOR =
  '[silent heartbeat] Scheduled private self-check. Review pending matters privately. ' +
  'Do not narrate or publish plain prose; use an explicit send tool only if you deliberately choose to contact someone.';

/** Request-only turn a compile that ends on the agent's own message gets. */
export const CONTINUE_ROW = '[Continue]';

/** `metadata.promptedBy` on the first row a reply to a `[Continue]` turn
 * stores. */
export const PROMPTED_BY_CONTINUE = 'continue';

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
}

/** The tick stamp on a stored row's metadata, if any. */
export function silentHeartbeatOf(metadata: unknown): SilentHeartbeatStamp | undefined {
  const stamp = (metadata as { silentHeartbeat?: unknown } | undefined)?.silentHeartbeat;
  if (!stamp || typeof stamp !== 'object') return undefined;
  const { eventId, serverId, agentName } = stamp as Record<string, unknown>;
  return typeof eventId === 'string' && typeof serverId === 'string' && typeof agentName === 'string'
    ? { eventId, serverId, agentName }
    : undefined;
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

/** Whether a stored row is a reply's first row after a `[Continue]` turn. */
export function isPromptedByContinue(metadata: unknown): boolean {
  return (metadata as { promptedBy?: unknown } | undefined)?.promptedBy === PROMPTED_BY_CONTINUE;
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
   *  tick → the tick's event id. */
  ticks: Map<string, string>;
  /** Identity keys of the first row of each reply to a `[Continue]` turn. */
  continued: Set<string>;
  /** Ticks this agent has already stored rows for (its own, not another resident's). */
  started: Set<string>;
}

/** Index the rows that follow request-only turns: every row this agent stored
 * during its silent ticks, and the first row of each reply to a `[Continue]`.
 * The two are independent, so a row can be both. */
export function indexRequestOnlyRows(stored: readonly StoredRowLike[], agentName: string): RequestOnlyRowIndex {
  const ticks = new Map<string, string>();
  const continued = new Set<string>();
  const started = new Set<string>();
  for (const row of stored) {
    const stamp = silentHeartbeatOf(row.metadata);
    if (stamp && stamp.agentName === agentName) {
      started.add(stamp.eventId);
      if (row.participant === agentName) {
        for (const key of identityKeys(row.content)) ticks.set(key, stamp.eventId);
      }
    }
    if (isPromptedByContinue(row.metadata)) {
      for (const key of identityKeys(row.content)) continued.add(key);
    }
  }
  return { ticks, continued, started };
}

/**
 * Insert the request-only turns into a compiled window: a tick's separator
 * immediately before the first of the tick's rows that survives compilation
 * (its first row when rendered, otherwise whichever later row a strategy
 * kept), and `[Continue]` immediately before each reply it prompted, after
 * any separator, as the reply's request had them. Rows folded into
 * summaries simply do not match; ordinary messages pass through untouched.
 */
export function renderRequestOnlyRows(
  messages: NormalizedMessage[],
  index: Pick<RequestOnlyRowIndex, 'ticks' | 'continued'>,
  agentName: string,
): NormalizedMessage[] {
  if (index.ticks.size === 0 && index.continued.size === 0) return messages;
  const separated = new Set<string>();
  const out: NormalizedMessage[] = [];
  for (const message of messages) {
    if (message.participant === agentName) {
      const keys = identityKeys(message.content);
      const tick = keys.map((key) => index.ticks.get(key)).find((id) => id !== undefined);
      if (tick !== undefined && !separated.has(tick)) {
        separated.add(tick);
        out.push(silentHeartbeatSeparatorTurn());
      }
      if (keys.some((key) => index.continued.has(key))) out.push(continueTurn());
    }
    out.push(message);
  }
  return out;
}

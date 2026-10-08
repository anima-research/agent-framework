/**
 * Stored-row handling for silent heartbeat ticks.
 *
 * A silent tick stores no prompt row (#216): its reply is written straight
 * after whatever the window held before it — often the previous assistant
 * message, since a suppressed tick leaves no delivery receipt behind. The
 * wire formatter merges consecutive same-role messages, so without a turn
 * between them the tick would read as an unprompted continuation of the
 * earlier response and one assistant message would carry signed thinking
 * from two separate responses (a provider 400 when it is the latest
 * assistant message; see `Agent.addAssistantResponse`).
 *
 * Every row a tick writes is therefore stamped with `metadata.silentHeartbeat`
 * and, at request-build time only, a terse user turn is rendered immediately
 * before the first of the tick's rows that survives compilation. The
 * separator is never stored and its position is a function of the stamped
 * rows alone, so every compile renders it in the same place (the tick's own
 * request ends on the same turn), which keeps the prompt-cache prefix
 * stable — unlike a per-compile injection that re-anchors to the newest user
 * message.
 *
 * Known limit: compiled messages carry no store provenance, so a stored row
 * is recognised only by structural identity the provider made unique
 * (tool_use ids, thinking signatures). A tick reply with neither — unsigned
 * and tool-free — gets no separator and still merges as before. Without
 * signed thinking that merge carries no provider-rejection risk; it is only
 * a misreading. Reply text is deliberately never used as identity: identical
 * replies ("all quiet") would collide, and an ordinary reply with the same
 * text could take a tick's separator and rewrite cached history. Exact
 * matching for every row would need the compile result to expose each
 * message's source rows.
 */
import type { ContentBlock, NormalizedMessage } from '@animalabs/membrane';

/** Request-only separator text. Constant on purpose: it carries no time or
 * id, so it is byte-identical on every compile. */
export const SILENT_HEARTBEAT_SEPARATOR = '[heartbeat tick]';

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
  return { participant: 'user', content: [{ type: 'text', text: SILENT_HEARTBEAT_SEPARATOR }] };
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

export interface SilentTickIndex {
  /** Identity key of every assistant row this agent stored during a tick → tick event id. */
  rows: Map<string, string>;
  /** Ticks this agent has already stored rows for (its own, not another resident's). */
  started: Set<string>;
}

/** Index the rows this agent stored during silent ticks. */
export function indexSilentTickRows(stored: readonly StoredRowLike[], agentName: string): SilentTickIndex {
  const rows = new Map<string, string>();
  const started = new Set<string>();
  for (const row of stored) {
    const stamp = silentHeartbeatOf(row.metadata);
    if (!stamp || stamp.agentName !== agentName) continue;
    started.add(stamp.eventId);
    if (row.participant !== agentName) continue;
    for (const key of identityKeys(row.content)) rows.set(key, stamp.eventId);
  }
  return { rows, started };
}

/**
 * Insert the separator turn immediately before the first surviving row of
 * each tick in a compiled window — the tick's first row when it is rendered,
 * otherwise whichever later row a strategy kept. Rows folded into summaries
 * simply do not match; ordinary messages pass through untouched.
 */
export function separateSilentHeartbeatTicks(
  messages: NormalizedMessage[],
  rows: ReadonlyMap<string, string>,
  agentName: string,
): NormalizedMessage[] {
  if (rows.size === 0) return messages;
  const separated = new Set<string>();
  const out: NormalizedMessage[] = [];
  for (const message of messages) {
    if (message.participant === agentName) {
      const eventId = identityKeys(message.content).map((key) => rows.get(key)).find((id) => id !== undefined);
      if (eventId !== undefined && !separated.has(eventId)) {
        separated.add(eventId);
        out.push(silentHeartbeatSeparatorTurn());
      }
    }
    out.push(message);
  }
  return out;
}

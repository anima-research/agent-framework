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
 * before each tick's first stored row. The separator is never stored and its
 * position is a function of the stamped rows alone, so every compile renders
 * it in the same place (the tick's own request ends on the same turn), which
 * keeps the prompt-cache prefix stable — unlike a per-compile injection that
 * re-anchors to the newest user message.
 */
import { createHash } from 'node:crypto';
import type { ContentBlock, NormalizedMessage } from '@animalabs/membrane';

/** Request-only separator text. Constant on purpose: it carries no time or
 * id, so it is byte-identical on every compile. */
export const SILENT_HEARTBEAT_SEPARATOR = '[heartbeat tick]';

/** Identity of one authenticated silent heartbeat tick. Stored as
 * `metadata.silentHeartbeat` on every row that tick's turn writes. */
export interface SilentHeartbeatTick {
  /** The MCPL push event that woke the tick. */
  eventId: string;
  /** The MCPL server that sent it. */
  serverId: string;
}

/** The tick stamp on a stored row's metadata, if any. */
export function silentHeartbeatOf(metadata: unknown): SilentHeartbeatTick | undefined {
  const stamp = (metadata as { silentHeartbeat?: unknown } | undefined)?.silentHeartbeat;
  if (!stamp || typeof stamp !== 'object') return undefined;
  const { eventId, serverId } = stamp as Record<string, unknown>;
  return typeof eventId === 'string' && typeof serverId === 'string' ? { eventId, serverId } : undefined;
}

export function silentHeartbeatSeparatorTurn(): NormalizedMessage {
  return { participant: 'user', content: [{ type: 'text', text: SILENT_HEARTBEAT_SEPARATOR }] };
}

/**
 * Tokens that identify one stored response wherever a compile renders it.
 * Compiled messages carry no store metadata, so a stored row is recognised by
 * content that the provider made unique and strategies keep verbatim:
 * tool_use ids and thinking signatures (the same identity the tool-result
 * guard relies on). Only a response with neither falls back to its full text.
 */
function identityKeys(content: ContentBlock[]): string[] {
  const keys: string[] = [];
  const text: string[] = [];
  for (const block of content) {
    if (block.type === 'tool_use' && typeof block.id === 'string') keys.push(`tool_use:${block.id}`);
    else if (block.type === 'thinking' && typeof block.signature === 'string' && block.signature) {
      keys.push(`thinking:${block.signature}`);
    } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') keys.push(`redacted:${block.data}`);
    else if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
  }
  if (keys.length > 0) return keys;
  const joined = text.join('\n');
  return joined.trim() ? [`text:${createHash('sha256').update(joined).digest('hex')}`] : [];
}

export interface StoredRowLike {
  participant: string;
  content: ContentBlock[];
  metadata?: unknown;
}

/** First stored assistant row of every tick, as identity key → tick event id. */
export function indexTickLeadingRows(
  stored: readonly StoredRowLike[],
  assistant: string,
): { leading: Map<string, string>; ticks: Set<string> } {
  const leading = new Map<string, string>();
  const ticks = new Set<string>();
  const led = new Set<string>();
  for (const row of stored) {
    const tick = silentHeartbeatOf(row.metadata);
    if (!tick) continue;
    ticks.add(tick.eventId);
    if (row.participant !== assistant || led.has(tick.eventId)) continue;
    led.add(tick.eventId);
    for (const key of identityKeys(row.content)) leading.set(key, tick.eventId);
  }
  return { leading, ticks };
}

/**
 * Insert the separator turn immediately before each tick's first stored row
 * in a compiled window. Rows a strategy folded into summaries simply do not
 * match; ordinary messages pass through untouched.
 */
export function separateSilentHeartbeatTicks(
  messages: NormalizedMessage[],
  leading: ReadonlyMap<string, string>,
  assistant: string,
): NormalizedMessage[] {
  if (leading.size === 0) return messages;
  const separated = new Set<string>();
  const out: NormalizedMessage[] = [];
  for (const message of messages) {
    if (message.participant === assistant) {
      for (const key of identityKeys(message.content)) {
        const eventId = leading.get(key);
        if (eventId === undefined || separated.has(eventId)) continue;
        separated.add(eventId);
        out.push(silentHeartbeatSeparatorTurn());
        break;
      }
    }
    out.push(message);
  }
  return out;
}

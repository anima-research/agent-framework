/**
 * Another agent's rounds as an agent that watches its slot is sent them
 * (#291, answer 13).
 *
 * An agent reads another agent's rounds only through an observe edge
 * (decision 1): the persistent subconscious watching the residents' slot.
 * Those rounds are stored as the other agent's: its signed thinking, its
 * tool calls and their results. None of that is valid as the watcher's own.
 * A provider takes tool blocks only in their own pairing, in the turns of
 * the agent that made the call, and a thinking block's signature binds it
 * to the prefix the other agent was sent. Sent raw in a user turn, the
 * blocks are refused, or moved into the watcher's assistant turns, where
 * they read as calls the watcher made.
 *
 * So the watcher is sent them as a transcript, a line per block: a call as
 * the tool's name and its input in brief, a result as the tool's name and
 * its outcome in brief, and no thinking at all. Text, images and the rest go
 * as stored. The rule is one function of the stored row, applied the same
 * way to a compile's messages and to a row a tool boundary injects, so what
 * the watcher's window holds and what its requests carried stay one thing.
 *
 * The watcher's own rows go as stored: its rounds (its own participant's
 * messages), and the results of its own calls, which are stored under
 * another participant (`user`) and are told by the call they answer.
 */
import type { ContentBlock, NormalizedMessage } from '@animalabs/membrane';
import { NOTICE_TAG } from './notice-tags.js';
import { cutToFit, markedTexts, oneLine } from './supplied-text.js';

/** How long one transcript line's call or outcome runs before it is cut. */
const BRIEF_CHARS = 160;

/** A piece of a transcript line's call or outcome, and whether the other
 *  agent supplied it (a call's input, a result's text) or the framework
 *  wrote it (a placeholder naming a result block's kind). */
interface Piece {
  text: string;
  supplied: boolean;
}

/** `text` on one line: each line break the framework counts as one
 *  (oneLine), and each other run of whitespace, as one space. */
function flat(text: string): string {
  return oneLine(text).replace(/\s+/g, ' ').trim();
}

/** A tool result's content as pieces: its text, and its other blocks named
 *  by kind, in placeholders that are the framework's own. */
function resultPieces(content: string | ContentBlock[]): Piece[] {
  if (typeof content === 'string') return [{ text: content, supplied: true }];
  return content.map((b) => (b.type === 'text'
    ? { text: (b as { text: string }).text, supplied: true }
    : { text: `[${b.type}]`, supplied: false }));
}

/** A call's input as a piece: its JSON, or what the model sent when that
 *  wasn't an object. */
function callPiece(block: Extract<ContentBlock, { type: 'tool_use' }>): Piece {
  if (block.unparseableInput !== undefined) return { text: block.unparseableInput, supplied: true };
  try {
    return { text: JSON.stringify(block.input ?? {}) ?? '', supplied: true };
  } catch {
    return { text: '', supplied: true };
  }
}

/**
 * A transcript line: the framework's bracket around the tool's name, which
 * the other agent's call supplied, the framework's words for what happened
 * (`words[0]` before a call or outcome, `words[1]` when there is none), and
 * the call or outcome in brief. What the line holds is supplied text
 * (#852): set inside the framework's bracket here, where a tool block's own
 * content isn't, an opening of one of the framework's notices is marked
 * wherever it forms, read across the whole line (markedTexts): inside a
 * piece, across a result's blocks, or where the name meets the bracket or
 * the framework's words. Those words and the placeholders aren't marked.
 * Each piece goes on one line first (flat), and the call or outcome is cut
 * to BRIEF_CHARS with an ellipsis, at a whole character, never parting a
 * mark from its bracket (cutToFit).
 */
function transcriptLine(name: string, words: readonly [string, string], body: readonly Piece[]): string {
  const pieces = body.map((p) => ({ ...p, text: flat(p.text) })).filter((p) => p.text.length > 0);
  const word = pieces.length > 0 ? words[0] : words[1];
  const marked = markedTexts(['[', oneLine(name), word, ...pieces.map((p) => p.text)], [true, true, false, ...pieces.map((p) => p.supplied)]);
  const said = marked.slice(3).join(' ');
  return `${marked.slice(0, 3).join('')}${said.length > BRIEF_CHARS ? `${cutToFit(said, BRIEF_CHARS - 1)}…` : said}]`;
}

/** Where a row with nothing left to send stands, so the transcript keeps a row for each stored one. */
const NOTHING_SAID = `[${NOTICE_TAG.noText}]`;

/**
 * One stored row of another agent's as the watcher is sent it: thinking
 * dropped, each call and each result a line of text, a text block's
 * provider-native item (`rawItem`) dropped with it, everything else as it is.
 * `ownCalls` are the watcher's own calls, whose results it is sent as they
 * are; `callNames` names the calls the row's results answer, where the
 * result doesn't name its tool itself. A row left with nothing says so in
 * a line, rather than going empty.
 */
export function foreignRowAsSent(
  content: readonly ContentBlock[],
  context: { ownCalls?: ReadonlySet<string>; callNames?: ReadonlyMap<string, string> } = {},
): ContentBlock[] {
  let changed = false;
  const out: ContentBlock[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'thinking':
      case 'redacted_thinking':
        changed = true;
        break;
      case 'tool_use': {
        changed = true;
        out.push({ type: 'text', text: transcriptLine(block.name, [' called: ', ' called: '], [callPiece(block)]) });
        break;
      }
      case 'tool_result': {
        if (context.ownCalls?.has(block.toolUseId)) {
          out.push(block);
          break;
        }
        changed = true;
        const name = block.toolName ?? context.callNames?.get(block.toolUseId) ?? 'a tool';
        const word = block.isError ? ' failed' : ' returned';
        out.push({ type: 'text', text: transcriptLine(name, [`${word}: `, word], resultPieces(block.content)) });
        break;
      }
      case 'text': {
        if ((block as { rawItem?: unknown }).rawItem === undefined) {
          out.push(block);
          break;
        }
        changed = true;
        if (block.text.length > 0) out.push({ type: 'text', text: block.text });
        break;
      }
      default:
        out.push(block);
    }
  }
  if (!changed) return content as ContentBlock[];
  return out.length > 0 ? out : [{ type: 'text', text: NOTHING_SAID }];
}

/**
 * A request's messages as an agent that watches another's slot is sent them:
 * each message whose participant isn't the agent's own (`isOwn`) through
 * foreignRowAsSent, with the agent's own calls (those in its own messages)
 * kept, and each result named by the call it answers. A message nothing
 * changes is the same object, and so is the array when none changes.
 */
export function transcribeForeignRounds(
  messages: readonly NormalizedMessage[],
  isOwn: (participant: string) => boolean,
): NormalizedMessage[] {
  const ownCalls = new Set<string>();
  const callNames = new Map<string, string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue;
      if (isOwn(m.participant)) ownCalls.add(b.id);
      else callNames.set(b.id, b.name);
    }
  }
  let changed = false;
  const out = messages.map((m) => {
    if (isOwn(m.participant)) return m;
    const content = foreignRowAsSent(m.content, { ownCalls, callNames });
    if (content === m.content) return m;
    changed = true;
    return { ...m, content };
  });
  return changed ? out : messages as NormalizedMessage[];
}

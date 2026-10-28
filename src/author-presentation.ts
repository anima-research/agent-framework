/**
 * The author of a channel message, presented to the model.
 *
 * MCPL `channels/incoming` carries the author as a field, `author: {id,
 * name}`, and the body alone as content (SPEC §14); the framework stores
 * the message under the anonymous participant `user` with the author in
 * `metadata.author`. The wire formatter writes the participant, so without
 * this step the model reads `user: <text>` and who spoke is lost. Servers
 * that pre-render `Name: body` into the text themselves (portal-mcpl) are
 * left as they are: the rule is idempotent, so the name appears once
 * whichever shape a server sends.
 *
 * Applied where the framework stores a `channels/incoming` message — the
 * compiled view carries no metadata, so the name has to be in the stored
 * text to reach the wire — and to a tune-out backlog line, which reads the
 * metadata and must not name an author twice. The author stays in
 * `metadata.author` as the structured record.
 */
import type { ContentBlock, MessageMetadata } from '@animalabs/membrane';
import { suppliedValue } from './supplied-text.js';

/** The participant the framework stores channel traffic under: a role, not a name. */
export const ANONYMOUS_PARTICIPANT = 'user';

type TextBlock = Extract<ContentBlock, { type: 'text' }>;

/** The author a stored message names, when it names one. */
export function authorNamed(metadata: Record<string, unknown> | MessageMetadata | undefined): string | undefined {
  const name = (metadata?.author as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/** Whether `text` already begins with the author's own line: `Name:` then a space or the end. */
export function beginsWithAuthor(author: string, text: string): boolean {
  if (!text.startsWith(author) || text.charAt(author.length) !== ':') return false;
  const after = text.charAt(author.length + 1);
  return after === '' || after === ' ' || after === '\n';
}

/**
 * The author's name as a line of the framework's writes it: a value someone
 * supplied, kept to one line with its notice openings marked (main's #852,
 * suppliedValue), so a name can't open a line that reads as the framework's
 * own notice.
 */
export function authorShown(author: string): string {
  return suppliedValue(author);
}

/** Whether `text` begins with the author's line, as the author wrote their
 *  name or as the framework shows it (authorShown). */
function beginsWithAuthorLine(author: string, text: string): boolean {
  return beginsWithAuthor(author, text) || beginsWithAuthor(authorShown(author), text);
}

/** `author: text`, unless `text` begins that way already. */
export function authorLine(author: string, text: string): string {
  return beginsWithAuthorLine(author, text) ? text : `${authorShown(author)}: ${text}`;
}

/**
 * A message stored under the anonymous participant that names an author is
 * presented with the author before its first text block — or, with no text
 * block, as a leading `Name:` line before its media. Any other message, and
 * one whose text already begins with the author's line, is returned as is.
 * Never mutates its input.
 */
export function presentAuthor<M extends { participant: string; content: ContentBlock[]; metadata?: MessageMetadata | Record<string, unknown> }>(message: M): M {
  if (message.participant !== ANONYMOUS_PARTICIPANT) return message;
  const author = authorNamed(message.metadata);
  if (author === undefined) return message;
  const index = message.content.findIndex((b) => b.type === 'text');
  if (index === -1) {
    return { ...message, content: [{ type: 'text', text: `${authorShown(author)}:` } as TextBlock, ...message.content] };
  }
  const block = message.content[index] as TextBlock;
  if (typeof block.text !== 'string' || beginsWithAuthorLine(author, block.text)) return message;
  const content = [...message.content];
  content[index] = { ...block, text: `${authorShown(author)}: ${block.text}` };
  return { ...message, content };
}

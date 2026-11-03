import { markedText } from '../supplied-text.js';

/** The participant a module stores for a sender's name from outside the
 *  framework: on one line, with each listed notice opening marked as in
 *  supplied text, and marked with its source, so it isn't an agent's name
 *  unless a host names an agent in that form. The generic `user` stays as
 *  given, since context-manager places injections by the last message whose
 *  participant is `user`, in any capitalization. */
export function outsideSenderName(name: string, source: string): string {
  const line = markedText(name.replace(/[\p{Cc}\u2028\u2029]+/gu, ' '));
  return line.toLowerCase() === 'user' ? line : `${line} (${source})`;
}

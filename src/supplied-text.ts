/**
 * Text the framework didn't write (what a participant or a server supplied),
 * put beside structure of the framework's own: the reply judge's document.
 * A value that can end its line can start a line that reads as the
 * framework's own.
 */

/** Every form of line break a reader might take for one: CR LF, CR, LF,
 *  vertical tab, form feed, NEL, and the Unicode line and paragraph separators. */
const LINE_BREAK = /\r\n|[\r\n\u000b\u000c\u0085\u2028\u2029]/g;

/** Text with each line break, in whatever form, as `\n`. */
export function normalizeLineBreaks(text: string): string {
  return text.replace(LINE_BREAK, '\n');
}

/** A value kept to one line: each run of line breaks, in whatever form, as one
 *  space, so it can't end the line it's put in or start one of its own. */
export function oneLine(text: string): string {
  return normalizeLineBreaks(text).replace(/\n+/g, ' ');
}

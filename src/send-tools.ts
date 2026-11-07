/**
 * Tools whose call carries the resident's words, by bare name (an MCPL
 * server's `<prefix>--` stripped); edit_message's words are the new text of a
 * message it sent. The framework reads a call of a `silences` one as an
 * explicit send that silences the round's auto-routed prose where it may have
 * posted; the history module reads the words of any of them as what the
 * resident wrote to someone, whether or not it was delivered. With prose
 * routing disabled the resident speaks through these.
 */
const SPEECH_TOOLS: ReadonlyMap<string, { words: readonly string[]; silences: boolean }> = new Map([
  // channel_publish still takes `text` from older callers.
  ['channel_publish', { words: ['content', 'text'], silences: true }],
  // telegram-mcpl's send_message takes `message`.
  ['send_message', { words: ['content', 'message', 'text'], silences: true }],
  ['reply_message', { words: ['content', 'text'], silences: true }],
  ['send_dm', { words: ['content', 'text'], silences: true }],
  // telegram-mcpl's reply, file send, scheduled send and poll.
  ['reply_to_message', { words: ['text'], silences: true }],
  ['send_file', { words: ['caption'], silences: false }],
  ['send_scheduled_message', { words: ['message'], silences: false }],
  ['create_poll', { words: ['question'], silences: false }],
  // telegram-mcpl's edit_message takes `new_text`.
  ['edit_message', { words: ['content', 'new_text', 'text'], silences: false }],
  // slack-mcpl's upload_file posts `comment` with the file; its `content` is
  // the file.
  ['upload_file', { words: ['comment'], silences: false }],
  // Eidoverse's say and whisper take `text`.
  ['say', { words: ['text'], silences: true }],
  ['whisper', { words: ['text'], silences: true }],
]);

export const SILENCING_SENDS = new Set([...SPEECH_TOOLS].filter(([, tool]) => tool.silences).map(([name]) => name));

/** Strip the `server--` MCPL prefix from a tool name. */
export const bareToolName = (n: string): string => n.split('--').pop()!;

export function speechOf(name: unknown, input: unknown): { tool: string; words: string } | undefined {
  if (typeof name !== 'string' || typeof input !== 'object' || input === null) return undefined;
  const tool = bareToolName(name);
  const row = SPEECH_TOOLS.get(tool);
  if (!row) return undefined;
  const args = input as Record<string, unknown>;
  const words = row.words.map((arg) => args[arg]).find((value) => value !== undefined && value !== null);
  return typeof words === 'string' && words.trim().length > 0 ? { tool, words } : undefined;
}

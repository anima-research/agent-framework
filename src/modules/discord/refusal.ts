/**
 * A refusal the Discord module gives the agent as worded: Discord refused the
 * request, its target can't take it, or a lookup before the tool's change (a
 * send, an edit, a deletion, a reaction or a thread) stopped on an unexpected
 * error, so the tool did nothing, and the message says why and what to do
 * instead. A thread a send asked for and didn't get isn't one: the send
 * returns why as words, since its message is out.
 * Anything else a tool throws is an unexpected error, which the module words
 * itself (DiscordModule.handleToolCall).
 */
export class DiscordRefusal extends Error {
  override readonly name = 'DiscordRefusal';
}

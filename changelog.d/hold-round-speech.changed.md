- **MCPL servers that take the outgoing stream (`channels.streaming`):**
  chunks now arrive once each publish is confirmed, one per published
  message, rather than token by token while the model writes. A round
  reaches a voice server once the model has finished writing it, its
  routing is decided and its publish is confirmed, after any earlier post
  of the agent's still in flight. A later message to the same channel
  within one stream opens with a paragraph break (`\n\n`), so the
  channel's chunks joined in `index` order are its text, which `complete`
  carries, with its messages kept apart. A server that read chunks as a
  sign the agent is composing, such as eidoverse-worlds' typing dots, now
  sees them only as a reply is published; `channels/typing`, which the
  host sends for the whole turn to a server granted `channels.typing`, is
  that signal.
- Agents with `toolWrapperProseGuard` now stream their delivered prose. The
  stream was off for them because it ran ahead of the guard's
  classification; it now carries only prose that delivery published, and a
  wrapper the guard contains is never published. Wrapper-shaped text the
  guard doesn't match, as in a turn that has made a real tool call, was
  already posted as ordinary prose, and now streams too.

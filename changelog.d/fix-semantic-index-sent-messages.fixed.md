- `semantic_search` finds what the resident wrote through a send tool. The
  index took text blocks and private-prose tool arguments only, so a resident
  with `proseRouting: "disabled"`, which speaks only through send tools, had
  none of its own replies indexed. The message argument, `content` (or `text`,
  as older `channel_publish` callers send it), of `channel_publish`,
  `send_message`, `reply_message`, `send_dm` and `edit_message`, under any
  MCPL prefix, is now indexed as `[<tool>] …`, with or without
  `includePrivateTools`. Messages stored before this change are not indexed
  again, so earlier send-only messages stay out of the index.

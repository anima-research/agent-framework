- **Residents:** a turn's `[delivered]` receipt now names what kept its
  plain speech private, where it listed every possible cause. One cause:
  `1 plain-speech segment(s) kept private (skip_reply)`. Two or more, each
  with its count, in the order skip_reply, `>>>skip_reply`, a drafts call, a
  private think: `2 plain-speech segment(s) kept private (1 by skip_reply,
  1 by a private think)`. A round that calls skip_reply and holds a private
  think counts its plain speech once, under skip_reply.
- A `code_execution` round withheld because its turn moved on before its
  script calls returned is still logged, and no longer adds to the turn's
  count of suppressed segments. So a receipt's suppressed line now comes
  only from `proseRouting: "disabled"`, and reads as before.

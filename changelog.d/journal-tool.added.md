- `journal({content})` — a synthesized private note-taking tool beside `think`
  and `skip_reply`. The entry stays in the agent's own context and is sent
  nowhere; it does not end the turn and does not affect prose routing. It exists
  because long prose kept in `skip_reply.reason` (or `think.content`) makes
  replayed history read as a reasoning trace, and every memory-compression
  request over it is refused `reasoning_extraction` regardless of content,
  while the same prose in a note-taking tool passes. Context-manager's
  `compressionToolProseFallback` rung rewrites old history into calls to this
  tool and mirrors its result wording.

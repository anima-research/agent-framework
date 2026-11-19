- A rewind on a presented window (the default) no longer leaves a tool call
  without its result when system notices sit between them (#737). The
  refusal rewind, `/unstick` and the inference-failure quarantine took the
  result alone, and membrane answered the left call with a synthesized
  `[pending]` result on the next request. The shed now takes the call body
  with the result body in one retraction, as an undone turn's, and leaves
  the notices in the window, when the pair is proven: only system notices
  sit between them (no rewind marker), the call body holds only calls and
  the result body only results, their tool IDs are the same set, no other
  call or result in the agent's record or window uses any of those IDs, and
  every row of both carries the same owner and audience stamps (a row
  stored with no stamp, whose writer is unknown, proves no pair). Any other
  shape sheds as in 0.34.0, and so does a window that is still the record
  (legacy mode: after a failed write-down, or when a strategy couldn't
  follow a branch move). The record keeps every row, as before.

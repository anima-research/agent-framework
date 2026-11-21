- A rewind on a presented window (the default) no longer leaves a tool call
  without its result when system notices sit between them (#737), when the
  pair is proven. The refusal rewind, `/unstick` and the inference-failure
  quarantine took the result alone, and membrane answered the left call
  with a synthesized `[pending]` result on the next request. The shed now
  takes the call body with the result body in one retraction, as an undone
  turn's, and leaves the notices in the window, when: only system notices
  sit between them (none of them a rewind marker, a host
  change (`system_change`) or a tool block); the call body holds no results and
  the result body no calls (either can also hold text or thinking); their
  tool IDs are the same set, each a nonblank string that appears once in
  its body; both bodies are in the agent's own record, not only presented
  from another slot's (a persistent subconscious's view of its primary,
  whose record isn't checked); no other call or result in the agent's
  record or window uses any of those IDs; and every row of both carries the same owner stamp and
  the same audience stamp. A row with no owner stamp (one stored before
  stamps, or a module's write, which is stamped with an audience only) has
  an unknown writer and proves no pair. A result body right after a call
  body pairs with it as before, whatever its IDs or stamps. Any other
  shape across notices sheds as before: the result alone, which can
  still leave its call, or, when the request carried the call and not
  its result, the call alone, which leaves the result.
  On a presented window the record keeps every row, as before. A window
  that is still the record (legacy mode: after a failed write-down, or
  when a strategy couldn't follow a branch move) sheds as before, does
  not look across notices, and removes the shed rows from the record.

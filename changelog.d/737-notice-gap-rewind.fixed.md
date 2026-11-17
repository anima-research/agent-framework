- A rewind whose newest row is a tool result now takes the whole exchange when system notices, or other result bodies of the same call, sit between the call and that result (#737). Across such a gap the call is found by tool-use ID, and split result bodies and a sharded assistant body go whole. Before, only the result left and the next request still carried the call and its signed thinking.
  - A result right after an eligible, barrier-free call body is paired with it whatever the IDs (the legacy proximity rule). Hidden/system tool-call shards and body barriers prevent pairing even when adjacent.
  - Unresolved retention limitation: the notices inside the exchange go with it: they leave the agent's window, or the record on a window that is still the record. No other agent's window changes on a presented window.
  - Not paired, so call and result are shed one at a time, newest first, as before: a result across a gap whose IDs are missing or do not all match the call, and a result with a rewind marker, a hidden/view-excluded notice or tool call, or any row other than system notices and results of the same call, between it and its call. Obsolete `reasoning-loss` notices, omitted from all requests, do not stop pairing. A rewind marker is never taken with an exchange.
- Rewind selection now applies the same visibility checks on a legacy raw window,
  respects system-change and rewind-marker barriers even in mixed bodies, and
  accounts for every shard it retracts or removes. Passed-over result bodies are
  considered once rather than once per shard; backward pairing walks can still
  be quadratic across many distinct result bodies. Tool-exchange size descriptions
  use UTF-8 bytes of JSON-serialized, blob-resolved stored content (not the
  compiled wire request), including call input, thinking/signatures, escaping and base64 data throughout
  the removed interval. Image counts cover top-level image blocks in that whole
  interval, not only the newest result.
- Across a gap, pairing checks results in mixed call/result bodies as well as
  later results. Hidden call shards cannot borrow visibility from narration,
  and a visible whitespace shard cannot borrow request content from a hidden
  shard when choosing a body to shed. Uncarried mixed result/call bodies cannot
  use the carried-call result exception
  to discard new calls. Hidden notice-only shards in a result body stop pairing
  across that body; stored result shards retain their existing exception.
  Removal still takes each body whole.
- A barrier can still leave a call after shedding its result alone; this counts
  against the ordinary rewind budget. No budget bypass or partial-pair repair is
  introduced, and unrelated notice retention remains a maintainer decision.

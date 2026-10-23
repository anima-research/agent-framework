- The agent registry's durable state keeps `main`'s rules for the framework's
  own state (nissa's review of #546, findings 1 to 5). A registry that can't
  be read, or that reads as another version, refuses the start and names the
  state, where before it was taken as empty and overwritten by the first
  registration. A failed registry write, ended-log append or sync fails the
  call that made it, and a result whose hold isn't durable is not delivered
  (it stays held for the next attempt); a hold whose write fails leaves
  memory too, so a retry holds it once. The registry and its ended log are
  recovery files beside the store (`recovery/dendrite-registry.json`,
  `recovery/dendrite-ended.json`), which win over the branch-local state, so
  an undo or an operator's surgery can't erase a held result or the record
  of work that ran; the branch-local copies stay for inspection and for
  stores that predate the files. At boot, interrupted work is settled and
  held mail redelivered after host mode and the deferred-write queue are
  restored, so a quiesced host holds them as it holds any write, and mail an
  entry of the restored queue carries is left to that entry's landing rather
  than delivered twice under one id. Every agent that ends — by `stopAgent`,
  by the idle reap, with its parent — is released through one path, which
  releases its window as the reap did: a failure notice it never read
  reaches the primary, and a write queued for it lands in its window.

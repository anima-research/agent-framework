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
- The second round of the same review: a change a caller asks for — a
  registration, an end, a reparent, a hold — is put back when its write
  fails, so the call fails and changes nothing and a retry does it once (a
  stop whose write failed had left the agent recorded as stopped while it
  ran). A write that records something that has already happened — a
  release, a held mark, a message path — is not failed: it alerts, stays in
  memory, and the next write carries it. A result's hold is durable as it is
  written, so no store sync decides the delivery; the release is written
  only once the store has synced the landed message, so a hard exit between
  the two leaves the mail held and the next boot's check of the recipient's
  store settles it, never a release on disk for a message that isn't. A
  version-1 registry whose records or mail are not lists is refused, not
  taken as empty. A reader of the residents' shared slot that ends — a
  resident dropped from the configuration — is reopened on the slot it
  read, through the residents' view, where before an isolated namespace
  showed none of its messages.


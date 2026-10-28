- **Hosts and module authors: the deferral queue is gone** (#291). A context write is stored at once, whatever its
  agent's turn and whether the host is quiesced, and enters each agent's window at that agent's presentation points
  (see the presentation index's entries). Only two things keep a write out of the store, each holding it in memory
  with the id `''`: a live operator surgery (a rollback, a suppression, a branch switch), whose release stores it in
  arrival order, and an agent's context manager that refuses its work after a failed re-initialization, which keeps
  each write for the agent until a `switchBranch()` re-initializes it and that switch's release stores them in
  arrival order (if the agent ends first, those the primary takes in its place, a module's write for a run or a fork,
  a failed reply's notice or a channel notice it could act on, go on to it, and the rest are dropped, logged). A
  crash during the surgery, or before the recovery, loses such a write; earlier releases kept a quiesced host's queue
  on disk. The `store-held-long` alert says so: a restart loses the writes the hold keeps in memory and those kept
  for a manager refusing its work, where 0.28.0's said writes still queued at exit survive in a persisted deferral
  queue. The `context-reinit-failed` alert for a conversation agent a move disposes counts the writes held for it, by
  the move's hold or while its manager refused its work, and how many of them went to the primary, stored at the
  release; the rest, such as its channel's messages, are dropped, logged. A write made while quiesced is on the
  branch the store was on when it was made: a rollback or a branch switch later in the same quiesce leaves it there,
  where it used to land on the branch chosen by resume.
  - **Module authors:** `ModuleContext.addMessage` answers the stored id, never a `held:` handle. `ModuleMessage.held`
    keeps its name with a new meaning: the row is stored and not in the window of the agent the read is for (not yet
    presented to it, or taken out as an undone turn's); its `id`, `sequence` and `timestamp` are the store's. It is
    never set on an agent whose window is the record. `queryMessages` answers the stored rows in store order, each
    so marked, with the store's `totalCount`: rows of held writes are no longer appended as the newest. An edit or a
    removal of a row reaches it in the store, and changes what any window holding it sends next. For one release,
    `getMessage`, `editMessage` and `removeMessage` (and a process answer's edits and removals) still take a `held:`
    handle an earlier release answered, and reach the row its write landed as; the release after drops that.
  - **Tune-out hosts:** `ReaderInvocation.queued`, the `QueuedHeldMessage` type and
    `TuneOutFrameworkHooks.getDeferredMessages` are removed: a held message is stored as it arrives, so
    `ReaderInvocation.backlog` (and `ReaderFramingContext.backlog`) holds every message, as stored rows.
    `ReaderFramingContext.queuedCount` is deprecated and never set. A cancel's notice to the subconscious no longer
    carries held messages as `tune-out-cancel-held` rows after it: its view holds them stored. The trace
    `tune-out:reader-fork` loses `queued`.
  - **Hosts:** `WritePlacement.deferredId` and `CoalescingPlacement.deferredId` are removed (a placement names its
    stored `messageId`, or only its agent while the write is kept in memory). `HostModeStatus.deferredWrites` is
    deprecated, and counts the writes kept in memory, a live surgery's and those waiting for an agent's recovery (0
    otherwise). `quiesce()` no longer writes a queue and never throws `QuiesceBlockedError`, which stays exported,
    deprecated, for one release; the API server's 409 for it and the `host/command` refusal are gone. `FrameworkConfig.deferredWritesPath` is deprecated: it names where an
    earlier release's queue is read from at boot, once. `InferenceRequest.readsRow` is always a stored id.
  - **Traces:** `puppet:tool-call` loses `deferred`; `dendrite:mail-deferred` fires only for mail kept in memory (a
    surgery holds it, or its recipient's context manager refuses its work); `message:added` no longer comes with the
    `deferred-flush:*` sources (an imported write's is `deferred-import`). A write kept in memory is traced once, as a
    release stores it: `message:added` with its stored id and source `surgery-release`. Its arrival is never traced,
    where a module's process response, a resident's channel message, a push event and a script's wake traced it with
    the id `''` (or `'deferred'`) and a fork's channel message didn't, so a consumer keyed on the id or counting a
    source sees a held write once, under `surgery-release`.
  - **Rollback:** a release before this one reads the queue's record this one leaves (empty), so nothing is lost
    going back, but it reads the record as it reads a store, interleaved: rows stored for an agent during its turn
    are in its next compile where the record put them.

  **Migration:** a module that kept a `held:` handle across the upgrade can keep using it for one release, and
  should store the id `addMessage` answers from now on. A module that filtered `held` rows out of a query as not
  stored yet keeps working: they are now the rows the agent hasn't been shown. A host that read `deferredWrites` to
  know whether a quiesce held anything reads the agents' windows instead (`getPresentedMessages()`).

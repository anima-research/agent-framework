- **Hosts and module authors: the deferral queue is gone** (#291). A context write is stored at once, whatever its
  agent's turn and whether the host is quiesced, and enters each agent's window at that agent's presentation points
  (see the presentation index's entries). Only two things keep a write out of the store, each holding it in memory
  with the id `''`: a live operator surgery (a rollback, a suppression, a branch switch), whose release stores it in
  arrival order, and an agent's context manager that refuses its work after a failed re-initialization, which keeps
  each write for the agent until a branch move (a `switchBranch()`, a rollback or a suppression) re-initializes it
  and that move's release stores them in arrival order (across agents too, where writes for two such managers
  were kept: those for residents land in the one record they share in the order they came). Nothing caps the writes kept for such a manager: each one
  for its agent stays in memory until a move re-initializes it, and `HostModeStatus.deferredWrites` counts them
  (the `context-reinit-failed` alert that names the refusal says writes are kept meanwhile). An agent that ends
  while either keeps writes for it takes them out as it ends, not at the release:
  those the primary takes in its place, a module's write for a run or a fork, a failed reply's notice or a channel
  notice it could act on, go on to it (held by a hold still up until its release, as any write), and the rest are
  dropped, logged, with an `ops:alert` of kind `store-held-lost` for the agent (`data`: `count`, `passedOn`, `kinds`,
  `mail`, `agentEnded: true`); a release that still meets a write for an agent gone, or for a name another agent is
  registered under since, does the same, so a new agent of that name never gets an ended one's writes. A
  crash during the surgery, or before the recovery, loses such a write; earlier releases kept a quiesced host's queue
  on disk, and with it the writes a surgery deferred while the host was quiesced or its queue already on disk. So does a release whose store throws for one, none of its rows
  landing: the writes after it go on, and the release logs the loss and raises an `ops:alert` of kind
  `store-held-lost` for the agent, with the counts and kinds as at a stop, where earlier releases kept such a write,
  and its agent's writes after it, queued for the next drain. A write whose store throws after its rows landed counts as stored, here and on the
  write path the release replays (an inbound channel message or push, a fork's channel message, a module's write):
  context-manager names those rows (`WriteLandedError`), and the write is placed, presented and answered by them as
  if its store hadn't thrown, the throw logged. So a coalesced occurrence stored that way isn't stored again as its
  fallback, and a surgery's release traces such a write as stored. One whose store throws where the store can't be
  read to tell what of it landed (`WriteOutcomeUnknownError`, which names the rows context-manager knows are stored
  and counts those it can't name) is answered by that error, not as stored, on the same paths, the rows it names presented and the throw logged. An agent's own row (its rounds, its tool results, a row written through `storeOwnRow`) whose store throws `WriteLandedError` enters its window as its write would have, before the error is passed on, so a later own row can't enter ahead of it; of the rows a `WriteOutcomeUnknownError` names, those the store reads as held are presented. A module's `addMessage` throws it, and a write that carried `metadata.external` is
  then looked up in the store by `findMessageByExternalId`. A surgery's release counts such a write as one that may
  be lost: it traces the first row named as stored, and its `store-held-lost` alert says the write may be lost,
  naming the rows the store holds and may hold (`data.mayBeStored`: `count`, `landed`, `unknown`, `unnamed`). A
  coalesced render's delivery stores nothing then: its batch's recovery wake delivers it again saying it may be
  stored, and the agent's store is read back first for the occurrence's rows, by the subject and event id they carry.
  Rows found are placed as the delivery, and no fallback is stored; with none found, the fallback is stored; and
  where the store still can't be read, the fallback is stored and a line logged names the occurrence the agent may
  then see twice. Any other throw means none of the write landed. A write whose store refuses it as it is made, on
  the ordinary write path, is lost, logged. In earlier releases such a write made during its agent's turn (or while
  quiesced, or during a surgery) was queued, and the queue kept it when its flush was refused, so a refused failure
  notice for a fork was passed to the primary at the fork's release; it no longer is.
  A tune-out's cancel asked for meanwhile (its end time passing, a wake past its budget, a tool's or a host's
  cancel), or while the primary's or the subconscious's context manager refuses its work before anything is kept for
  it, waits, the tune-out in force, until the release has stored the writes, or told of those it couldn't, then runs,
  so its release is never kept in memory behind an end already on disk; `cancel()` and `cancelAllExcept()` answer
  `{ ok: true, deferred: true }` then. A later cancel while one waits adds its note to the waiting cancel if the waiting cancel has no note, or if its own note has already gone out. Otherwise the later note is dropped and logged, and the answer adds `noteDropped: true`. The tools say so to the
  agent, where they answered `cancelled`: the resident's `tune_out` cancel answers `waiting` (the channel's name, or
  `'all-except'`) and the subconscious's `cancel_tuneout` `waiting: true` (with `scope: 'all-except'` for that
  hold), each with a `note`: not cancelled yet, since an operator's change to the store is in progress or a context
  the cancel writes to refuses writes until the host re-initializes it; cancelling again doesn't end the wait
  sooner while that lasts (once writes are stored, a cancel whose run failed is retried at the next release or within 60 s, and another cancel of the hold can end it first); the tune-out stays in force, and when it ends what it still holds is delivered, up to its backlog cap and what fits in one message; and a host that stops first loses the cancel, which the restart doesn't run. After such a restart the tune-out is still in force, even where its release reached the resident, until it is cancelled: the restart cancels it itself if its end time has passed or, for a channel's tune-out, its wakes have gone past their budget, and cancels every hold if the host starts again with no reader. A note left with a waiting cancel is accounted for when the host stops or crashes first. A stop keeps a notice of its loss in the store (`tune-out/<primary>/loss-notices`) and stamps the holds it accounted for (`tune-out/<primary>/stop-stamp`, with its run's `branch` and the turns still owed, `wakesOwed`); a stop whose budget runs out while such a note is still in memory leaves that hold out of its stamp. The next boot tells the persistent subconscious, with a turn to read it, what became of that cancel and its note, from the notice the stop kept or, for a hold the stamp doesn't cover, from that run's stored rows (with the tool-result guard on, the original `cancel_tuneout` answer is read from `framework/tool-result-guard`'s staged batch): that the cancel ran, that the note was delivered, that the cancel was lost with its note, or that this isn't known and the note may be lost. Those notices carry `lossNoticeId`, `keptAtSequence` and `lostAtStop`, so a later boot neither tells a loss twice nor takes a later ask as told. On the first start on a store with no stamp, as every store an earlier release wrote, the holds on record count as stopped cleanly, and a line is logged. While the store hasn't recorded this run's start, a waiting `cancel_tuneout` answer to the persistent subconscious whose cancel carries its note warns that a stop or a death before the cancel runs may go untold. The subconscious's waiting answer names the server (`serverId`) where a bare channel id answers two servers' holds. A reader fork's note lost at a stop is logged. A release records who asked for its cancel (`cancel.by`, `cancel.askers`). Traces: `tune-out:deferred-cancel-dropped` (`hold-ended`, `note-undelivered`, `stopped`, `superseded`) and `tune-out:stop-unrecorded` (`found`: `ran`, `delivered`, `asked` or `unknown`).
  `cancel_tuneout`'s note says too when the caller's note isn't delivered (`noteDropped`). A waiting cancel ends only the hold it was asked for: one whose hold has ended meanwhile, or that a cancel of a later hold there finds waiting, is dropped, ending nothing, and the author of a note it carried is told in its own context that the note was dropped with it. A note left with a waiting cancel goes to the resident when any cancel of that hold ends it, ahead of that cancel's own: the persistent subconscious's before the release, under its name, and a reader fork's after it, as its mail, even after the fork's run has ended. If writing it fails, its author is told so and why, the persistent subconscious in the release itself, with a turn to read it, and a reader fork in its own context while its run lasts; a notice that can't be written yet is tried again until it is, and one written after a drop says whether the later hold it names is still in force. A `channel_close` of the
  channel an all-except hold excepts carries what became of the focus, whatever became of the close (`note` on a
  success, where it said nothing, and after the error on a failure): that the focus ended, or that the focus is still in force while its release waits for held writes. Which of the two is read when the answer is built, after the close's round-trip, during which a waiting release may have run; while it still waits, the close answers "The close asks to cancel the all-except hold that excepts this channel." ("This call asks …" for a channel its server no longer registers) and the waiting note. A crash before the cancel
  runs leaves the tune-out in force for the next boot, which cancels one whose end time passed. The
  `store-held-long` alert says so: a restart loses the writes the hold keeps in memory and those kept
  for a manager refusing its work, but mail, which stays held in the registry for the next boot, where 0.32.0's (0.28.0's
  text) said writes still queued at exit survive only in a persisted deferral queue. `stop()` names what it leaves unstored: for each agent with writes still kept in memory, those kept while
  its manager refuses its work (lost) and those a surgery whose operation outlived `stop()`'s wait still holds, it
  logs one `[stop] agent=<name>: …` line and raises an `ops:alert` of kind `store-held-lost` with the counts and
  kinds (`data`: `count`, `keptForRecovery`, `heldBySurgery`, `kinds`, `mail`); mail among them stays held in the
  registry, and the next boot delivers it. A write a listener of that alert makes, kept in memory too, is named in
  a line and an alert after it. The `context-reinit-failed` alert for a conversation agent a move disposes counts the writes held for it, by
  the move's hold or while its manager refused its work, and how many of them went to the primary, stored at the
  release; the rest, such as its channel's messages, are dropped, logged. A write made while quiesced is on the
  branch the store was on when it was made: a rollback or a branch switch later in the same quiesce leaves it there,
  where it used to land on the branch chosen by resume.
  - **Module authors:** `ModuleContext.addMessage` answers the stored id, never a `held:` handle. A write kept in
    memory (by a surgery's hold, or for a manager refusing its work) is answered `''`, and until it lands it can't be
    read, edited or removed through the module's context: `getMessage`, `editMessage` and `removeMessage` have no id
    for it, `queryMessages` and `findMessageByExternalId` read the store, and its release stores it as it was first
    given. A module that must change such a write keeps the change and applies it once the row is stored: the release
    traces each write synchronously as it stores it, `message:added` with source `surgery-release` and the stored id,
    as the Discord module does for an edit or a delete of a message whose create was kept. A write that carries
    `metadata.external` maps its external id to the row it stored, so a second write under an id already mapped
    maps it to the newer row during its agent's turn too, and `findMessageByExternalId` answers that row; a write
    held for a live turn mapped the id to `''`, and the lookup answered the first row the store held under it.
    `ModuleMessage.held` keeps its name with a new meaning: the row is stored and not in the window of the agent the
    read is for (not yet presented to it, taken out as an undone turn's, or never presented to it: another agent's
    own row, a row meant for another agent, a row a tune-out holds, for a resident); its `id`, `sequence` and
    `timestamp` are the store's. It is never set on an agent whose window is the record. `queryMessages` answers
    the stored rows in store order, each
    so marked, with the store's `totalCount`: rows of held writes are no longer appended as the newest. An edit or a
    removal of a row reaches it in the store, and changes what any window holding it sends next. For one release,
    `getMessage`, `editMessage` and `removeMessage` (and a process answer's edits and removals) still take a `held:`
    handle an earlier release answered, and reach the row its write landed as; the release after drops that.
  - **Tune-out hosts:** `ReaderInvocation.queued`, the `QueuedHeldMessage` type and
    `TuneOutFrameworkHooks.getDeferredMessages` are removed: a held message is stored as it arrives, so
    `ReaderInvocation.backlog` (and `ReaderFramingContext.backlog`) holds every message, as stored rows.
    `ReaderFramingContext.queuedCount` is deprecated and never set. A cancel's notice to the subconscious no longer
    carries held messages as `tune-out-cancel-held` rows after it: its view holds them stored. The trace
    `tune-out:reader-fork` loses `queued`. With no queue, a cancel's release fails to be stored or made durable
    only where its write throws or the store's sync fails (`commitDeliveries` answers false); a release, or a
    queued run's note, kept in memory as it is written (a hold that begins with that write) makes the cancel wait,
    as above, so no queue over its cap keeps a tune-out in force
    (0.31.0's entry on the order of a cancel's dump and its end); a dump's record of what it covered (`released`) names a held message by its
    id, and one an earlier release queued, which the boot's import stores, by its queued write's id, as that
    release's records name it.
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
    where a module's process response, a resident's or a fork's channel message, a push event and a script's wake
    traced it with the id `''` (or `'deferred'`), so a consumer keyed on the id or counting a
    source sees a held write once, under `surgery-release`.
  - **Rollback:** going back to a release before this one needs a copy of the store taken before the upgrade: the
    first window write-down that holds rows, or any presentation of more than one row, moves the store's MANIFEST to
    version 2, which those releases refuse (see Breaking: every agent's context follows its own presentation index), and what this release stored
    after the copy was taken isn't in the copy. The queue's record this release leaves (empty once its writes are
    imported) is itself harmless to an earlier release, which reads it as a queue with nothing in it. A store that
    hasn't moved to version 2 still opens there, and is read as an earlier release reads any store, interleaved:
    rows stored for an agent during its turn are in its next compile where the record put them.

  **Migration:** a module that kept a `held:` handle across the upgrade can keep using it for one release, and
  should store the id `addMessage` answers from now on. A module that filtered `held` rows out of a query as not
  stored yet drops that filter: every row a query answers is stored, and `held` now also marks rows that never
  enter the agent's window (another agent's own rows, rows meant for another agent, rows a tune-out holds, for a
  resident), which such a filter leaves out for good. A host that read `deferredWrites` to
  know whether a quiesce held anything finds nothing held by it: a write made during a quiesce is stored at once
  (unless one of the two holds above keeps it), an agent's own rows enter its window as they are written, and the
  rest enter the window of each agent with no turn alive at resume, and a draining turn's agent's at that turn's
  next presentation point. Such a write is as durable as any other: the store's periodic sync keeps running while
  the host is quiesced, so it reaches disk at the next sync, as it would with the host running, where earlier releases
  kept it in the queue the quiesce wrote.

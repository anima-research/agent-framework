- Per-channel receipt clocks in `channel_list` (shelf-354). Each channel gets
  three clocks:
  - `lastReceivedAt`: when this host accepted an item from the channel,
    including notices and deferred work, with its source message id and
    timestamp.
  - `lastDeliveredAt`: when a provider round that stood (not a refusal) last
    carried a new raw body from the channel to the calling resident, complete
    and unaltered.
  - `lastPartialAt`: a body that arrived only partially and hasn't arrived
    whole since.
  - Rounds are confirmed from membrane's round report on the `usage` event.
    Without one, nothing is confirmed, and `receiptClocks.roundReports` says
    so.
  - Versions are identified by the producer event id where the lane
    guarantees one, otherwise by platform message id plus a body digest,
    otherwise by the stored copy. Each delivery names its basis, and
    re-presenting a delivered version never moves a clock.
  - The clocks live in a store-scoped, unbranched `RecordJournal`, so a
    delivery survives `/undo`. Deduplication is exact and persistent: every
    delivered version is remembered, so a version counts when it first reaches
    the resident at any age, and never again. `receiptClocks` names the scope
    (store id, agent), `trackingSince` and coverage gaps: an unclean previous
    run, or a ledger write that failed, which never blocks delivery.
  - Request preparation captures immutable evidence of the bodies each request
    carries (`Agent.prepareActivationRequest`; `StartStreamResult.evidence`).
- `history--folds {since?, limit?, branch?}`: the resident's fold record, from
  the context manager's journal (shelf-381). Receipts come newest first, with
  one readable line per changed run or baseline run, the cause, the round's
  provider usage (whole-round, never a fold's cost), and a sentence naming how
  the strategy renders history ("never folds", "never summarizes"). A host that
  projects receipts to a file reports its export status through
  `HistoryModule.setFoldExportStatus`, and the tool shows it. Nothing is
  injected into context.
- The first provider round of a compile that stands now calls
  `ContextManager.acceptRound` with that round's own usage, which writes fold
  receipts.

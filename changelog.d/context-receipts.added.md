- Per-channel receipt clocks in `channel_list` (shelf-354). Each channel gets
  three clocks:
  - `lastReceivedAt`: when this host accepted an item from the channel,
    including notices and deferred work, with its source message id and
    timestamp.
  - `lastDeliveredAt`: when a provider round that stood (not a refusal) last
    carried a new raw body from the channel to the calling resident, complete
    and unaltered.
  - `lastPartialAt`: the most recent time a body from the channel first
    reached the resident only partially (cut, or altered on the way). It is
    history: a later complete arrival of that body moves `lastDeliveredAt`,
    not this clock.
  - Rounds are confirmed from membrane's round report on the `usage` event.
    Without one, nothing is confirmed, and `receiptClocks.roundReports` says
    so. A round whose fidelity isn't established (an adapter that doesn't
    report what it leaves out, an opaque request hook) confirms neither a
    delivery nor a partial exposure. `receiptClocks.roundFidelity` then
    counts such rounds for the calling resident since this process began
    ("unknown on N of M provider rounds since …"), so a path that can never
    confirm a delivery reads differently from one where nothing arrived.
  - Versions are identified by the producer event id where the lane
    guarantees one. Otherwise they use platform message id plus the digest
    ingestion recorded for the body as delivered, before any source header or
    sharding (`metadata.sourceBodyDigest`). Otherwise they use the stored copy.
    Each delivery names its basis, and re-presenting a delivered version never
    moves a clock.
  - A stored copy confirms delivery only while it still presents what
    ingestion stored. An unsharded copy must hash to its recorded
    `storedBodyDigest`, and a shard group must have declared its size
    (context-manager `shardCount`), with every declared shard carried. A copy
    edited after it arrived is a partial exposure, never a delivery. A copy
    whose fidelity can't be checked (stored before these digests or sizes
    were recorded) stays unconfirmed, neither delivered nor shown lost.
  - The clocks live in a store-scoped, unbranched `RecordJournal`, so a
    delivery survives `/undo`. Deduplication is exact and persistent: every
    delivered version is remembered, so a version counts when it first reaches
    the resident at any age, and never again. `receiptClocks` names the scope
    (store id, agent), `trackingSince` and coverage gaps: an unclean previous
    run, or a ledger write that failed, which never blocks delivery.
  - A ledger that can't be read never blocks startup or delivery. Until a
    whole read succeeds, nothing is written to it, `channel_list` reports the
    open gap (and no clocks until the ledger has been read once), and the
    read is retried. Tracking then resumes from the whole ledger, with the
    unreadable interval recorded as a gap.
  - Request preparation captures immutable evidence of the bodies each request
    carries (`Agent.prepareActivationRequest`; `StartStreamResult.evidence`).
- `history--folds {afterId?, since?, limit?, branch?}`: the calling agent's
  fold record (`afterId` a receipt id, `since` an ISO 8601 time),
  from its own context manager's journal (shelf-381), resolved through the new
  `ModuleContext.getAgentContextManager(agentName)`; a conversation fork or a
  second resident sees its own record, not the bound resident's. Receipts come
  newest first, with one readable line per changed run or baseline run, the
  cause, the round's provider usage (whole-round, never a fold's cost), and a
  sentence naming how the strategy renders history ("never folds", "never
  summarizes"). A host that projects the bound resident's receipts to a file
  reports its export status through `HistoryModule.setFoldExportStatus`, and
  the tool shows it to that resident. Nothing is injected into context.
- The first provider round of a compile that stands now calls
  `ContextManager.acceptRound`, which writes fold receipts. It passes that
  round's own usage and its presentation. The presentation is `altered` when
  request preparation or the producer reported an alteration. Otherwise it is
  `verbatim` when the round's fidelity is established, and `unknown` when it
  isn't.

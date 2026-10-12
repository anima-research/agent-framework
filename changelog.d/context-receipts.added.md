- Per-channel receipt clocks in `channel_list`. Each channel gets
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
    delivery survives `/undo`. Every deployment keeps one: the ledger records
    one small entry per accepted channel item, in the store next to the item
    itself, and one per first delivery or partial exposure. Deduplication is
    exact and persistent: every delivered version is remembered, so a version
    counts when it first reaches the resident at any age, and never again.
    `receiptClocks` names the scope (store id, agent), `trackingSince` and
    coverage gaps: an unclean previous run, or a ledger write that failed,
    which never blocks delivery. It lists the most recent 20 gaps, and
    `gapsOmitted` counts older ones. A channel is keyed by its binding, so a
    server reconfigured to another endpoint or command starts a separate
    history, as a session switch does.
  - A ledger write that fails inside the store (Chronicle's append can write a
    record and then fail its periodic sync, leaving it where this process
    can't read it back) stops the ledger's writes until the host restarts:
    its gap stays open, and the next start reads that record and reports the
    run as an unclean stop.
  - A ledger that can't be read never blocks startup or delivery. Until a
    whole read succeeds, nothing is written to it, `channel_list` reports the
    open gap (and no clocks until the ledger has been read once), and the
    read is retried. Tracking then resumes from the whole ledger, with the
    unreadable interval recorded as a gap. A run whose ledger never became
    readable records nothing, so a later run can't list that interval. An
    entry or checkpoint this version doesn't write makes the ledger
    unreadable rather than being skipped.
  - `channel_list`'s description stays short: what the clocks mean comes with
    them, as `receiptClocks.about` in its result. Its tool block still changes
    once, for every resident with channel tools.
  - Request preparation captures immutable evidence of the bodies each request
    carries (`Agent.prepareActivationRequest`; `StartStreamResult.evidence`).
- `history--folds {afterId?, since?, limit?, branch?}`: the calling agent's
  fold record (`afterId` a receipt id, `since` an ISO 8601 time), from its own
  context manager's journal, read through the new
  `ModuleContext.getAgentContextManager(agentName)`, which hands a module the
  two reads a fold reader needs; a conversation fork or a second resident
  sees its own record, not the bound resident's. Receipts come newest first,
  with one readable line per changed run or baseline run, the cause, the
  round's input and cache usage (the whole round's, never a fold's cost), and
  a sentence naming how the current strategy renders history ("never folds",
  "never summarizes"); each receipt names the strategy that wrote it. Each
  answer names the record it read (runtime, store, agent, namespace, data
  directory, branch) and explains its fields (`about`). A host that projects
  the bound resident's receipts to a file reports its export status and
  target through `HistoryModule.setFoldExportStatus`, and the tool shows them
  to that resident. Nothing is injected into context.
  - Every agent with the history module gets `history--folds` in its tool
    block, which changes once: module tools are offered per module, not per
    strategy, so a resident whose strategy keeps no receipts sees it too, and
    its answer says why the record is empty.
- The first provider round of a compile that stands now calls
  `ContextManager.acceptRound`, which writes fold receipts. It passes that
  round's own usage and its presentation. The presentation is `altered` when
  request preparation or the producer reported an alteration of the compiled
  messages. Otherwise it is `verbatim` when the round's fidelity is
  established, and `unknown` when it isn't. An injected body's alteration
  affects the clocks only, since injected bodies aren't compiled messages.

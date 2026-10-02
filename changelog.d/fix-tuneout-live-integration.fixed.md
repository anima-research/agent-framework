- Keep tuned-out traffic out of live resident tool continuations while making
  originals immediately available to the subconscious. Cancellation includes
  writes still deferred by quiesce, with backlog caps applied after deduplication.
- Route debounced and buffered tune-out wakes to the subconscious without
  waking the resident or replaying an ended epoch's wake into a new epoch.
- Disable subconscious prose publication, including explicit routing envelopes;
  channel speech must use the configuration-gated `speak_in_channel` tool.
- Restore tune-out cadence and duration timers from durable epochs even before
  connectors register their channels; overdue epochs cancel during startup.

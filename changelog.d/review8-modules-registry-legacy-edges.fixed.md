- An agent registry record written before own slots keeps reading the slot its observe edges read then. Such an
  edge with no `slot` read the residents' shared slot, whatever agent it named, but it was restored as an edge on
  that agent's own slot: a watcher recorded with `readsSharedSlot: true`, its own namespace and an edge
  `{ agent: 'worker-1' }` came back observing the worker's slot, with the shared slot as its own, so slot owners,
  readers and what was presented to it changed from what its record said, until it was declared again. Such an
  edge is now restored as an edge on the shared slot, the agent's name left off it, and the record's own slot is
  its namespace's.
  - **Migration (hosts):** a spec's edge `{ agent }` with no `slot` now reads that agent's own slot, not the
    shared slot. A spec written for the earlier meaning, naming an agent to read the shared slot, declares `{}` (or
    `{ slot }` for another namespace) instead; the restore above covers only the records stored before, until the
    agent is declared again.

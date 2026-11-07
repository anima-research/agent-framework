- An agent registry record written before own slots reads the slot its observe edges named then. Such an edge with
  no `slot` meant the residents' shared slot, whatever agent it named (0.32.0's `ObserveEdge` documents it so, though
  nothing read an edge then), and is restored as an edge on the shared slot, the agent's name left off it, the
  record's own slot its namespace's: a watcher recorded with `readsSharedSlot: true`, its own namespace and an edge
  `{ agent: 'worker-1' }` comes back observing the shared slot, not the worker's, so slot owners, readers and what is
  presented to it are what its record said.
  - **Migration (hosts):** a spec's edge `{ agent }` with no `slot` now reads that agent's own slot, not the
    shared slot. A spec written for the earlier meaning, naming an agent to read the shared slot, declares `{}` (or
    `{ slot }` for another namespace) instead; the restore above covers only the records stored before, until the
    agent is declared again.

- A turn start whose presentation fails (a read of the window or the record that throws, or a write of the window
  that leaves a row out) fails the start (#291). It is traced (`presentation:failed` at `turn-start` or `assembly`)
  and logged, the agent's turn ends, its trigger is dropped as any start's that throws is, and the rows wait outside
  its window for its next presentation point, so the agent doesn't answer an older context. In 0.32.0 a start whose
  flush of the deferred queue failed compiled without the writes it couldn't store, which stayed queued.

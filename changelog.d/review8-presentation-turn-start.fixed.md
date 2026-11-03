- A turn start whose presentation fails (a read of the window or the record that throws, or a write of the window
  that leaves a row out) fails the start, as a start whose read of the deferred queue failed did before the
  presentation index (#291). It is traced (`presentation:failed` at `turn-start` or `assembly`) and logged, the
  agent's turn ends, its trigger is dropped as any start's that throws is, and the rows wait outside its window for
  its next presentation point. Before, the start compiled without them, so the agent could answer an older context.

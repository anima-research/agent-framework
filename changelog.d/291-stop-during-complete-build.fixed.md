- A stop or an operator's quiesce abandon that lands while the results of a stream that completed with its tools
  still running are built (a spilled result's workspace write) now drops the round, as at an ordinary tool boundary:
  neither the round, its results nor the reply after its last tool block is stored, one `tool:result_dropped` goes
  out for the first call that was still running, and the turn ends with the stop's one `inference:aborted` (a
  caller's stop also leaves its `[turn-interrupted]` marker), with no `inference:completed`. Before, the round and its
  results were stored and the turn reported itself completed.

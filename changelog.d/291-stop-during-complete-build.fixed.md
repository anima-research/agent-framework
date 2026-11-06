- A stop or an operator's quiesce abandon that lands while the results of a stream that completed with its tools
  still running are built (a spilled result's workspace write) now drops the round, as at an ordinary tool boundary:
  neither the round, its results nor the reply after its last tool block is stored, one `tool:result_dropped` goes
  out for the first call that was still running, and the turn ends with the stop's one `inference:aborted` (a
  caller's stop also leaves its `[turn-interrupted]` marker), with no `inference:completed`. Before, the round and its
  results were stored and the turn reported itself completed.
- A stop made by a listener of the round's own presentation, as the round's reply and results are stored (their
  presentation traces synchronously), ends the turn the same way, at an ordinary tool boundary and after a stream that
  completed with its tools still running: the stream isn't resumed, and the turn ends with the stop's one
  `inference:aborted`. What is stored by then stays, the calls with their results, so the record holds no call
  without one. Before, the round went on: its stream was resumed after the stop.

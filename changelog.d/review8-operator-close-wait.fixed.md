- `channel_close` of the channel an all-except hold excepts, while that
  hold's cancel waits for held writes (an operator's change to the store,
  or a context that refuses writes), now answers as the tune-out tools
  answer a cancel that waits. The answer describes the wait while the
  writes are held: what the cancel waits for, that how long it lasts isn't
  known, that cancelling again doesn't end it sooner, and that a stop
  during it loses the cancel, so the hold is still in force after the
  restart unless its end time has passed.
  - After the writes are stored again, the cancel's release can still fail
    (its backlog isn't made durable, or a store operation throws). The
    cancel then stays queued, the hold in force, and is tried again at the
    next release or 60 s later.
  - Until that retry succeeds, another cancel of the same hold (the
    resident's, the reader's, its end time's, or another close) can end it
    first, and delivers the note the queued cancel carries. If writing that
    note fails, the note's author is told so and why (unless it is a reader
    fork that has ended), and the loss is traced.
  - A stop before the retry succeeds loses the queued cancel, and the hold
    is still in force after the restart unless its end time has passed.

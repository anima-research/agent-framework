- `channel_close` of the channel an all-except hold excepts, while that
  hold's cancel waits for held writes (an operator's change to the store,
  or a context that refuses writes), answers as the tune-out tools
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
    note fails, the loss is traced, and the note's author, unless it is a
    reader fork whose run has ended, is told so and why; an ended fork is
    written nothing, and the loss, reaching no one, is traced. A notice that
    can't be written is traced, kept, and tried again until it is written.
    One for the persistent subconscious is kept in the store too, so it
    survives a stop: the next boot writes it into the subconscious's
    context, with the reason. A reader fork's is dropped at a stop.
  - A stop before the retry succeeds loses the queued cancel, and the hold
    is still in force after the restart unless its end time has passed, or
    the host starts again with no reader, which ends every hold on record.

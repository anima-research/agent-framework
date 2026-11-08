- A turn whose compile is refused for budget while compression is pending
  now waits, idle, and runs once compression has made room, instead of
  ending (#304). The refusal comes before any provider call, for example
  after an immediate budget decrease. Before, the error policy retried it
  into the same refusal within seconds and ended the turn, and once
  compression had caught up nothing ran it again, so the agent stayed silent
  until its next wake. A refusal with nothing pending, an ephemeral run, and
  a framework that `start()` hasn't started fail as before.
  - **While it waits** the agent is idle: a surgery, a branch switch, an
    undo, a redo or a puppet call is admitted, a quiesce drains at once, and
    the wait holds no place in the event gate. `getHostModeStatus()`'s
    `gatedRequests` counts the waiting turn and the wakes that joined it.
    Wakes that arrive join the wait. For a turn's first start, their messages enter the agent's window
    as they arrive, and the released start answers them all. For a turn
    already under way (a budget restart's continuation, or a retry), they
    stay out of its request and run as a turn of their own after it.
  - **When it runs:** the waiting requests are queued again once something
    the refused compile depends on has changed: compression has made
    progress (a summary written since the wait began, or, for a strategy
    with no progress snapshot, a call that landed), compression has nothing
    left pending, a surgery or an undo has changed the window, the agent's
    budget or live context settings have changed, or a quiesce has ended.
    Their start's own compile is the check. Refused again while compression
    is pending, they wait again, and each such start traces its own
    `inference:started` and `inference:failed`. A compression call that
    fails releases nothing. The wait drives compression itself, ticking the
    agent's context manager once, and again only while a strategy with no
    progress snapshot lands a call each tick; with the maintenance timer off
    it drives it again every 5 seconds. A compression
    call that fails in a tick it drives is reported as one in a maintenance
    pass is.
  - **What the refused start stored:** the context injections it stored
    leave the agent's window as its turn starts waiting, since no request
    carried them, and the released start stores them as it would without
    the wait. A routing notice it stored stays, so its arrivals stay
    announced, and an undo of the released turn leaves it.
  - **No time limit:** a turn waits as long as compression stays pending.
    A waiting turn lives in memory, so a restart drops it, and the agent
    waits for its next wake, as after an exhausted turn before.
  - **The note:** the released turn reads "[budget-hold] Your context didn't
    fit its budget (100,201 tokens against 48,568) when this turn came to
    start. This turn waited 7 min.", from the hold to its release. It's
    stored once that start's
    compile has gone through (a failed write is logged, and the turn runs
    with the note unstored), where the compile placed it, so the next
    request starts with the same messages and a reply keeps its thinking. A
    start gets no note where a row the agent reads follows the last `user`
    message, since a stored row would land elsewhere: a wake with nothing
    new, or a start that stored a context injection after the message. With
    no `user` message, the note goes at the window's end.
  - **A surgery or an undo:** a waiting turn whose trigger's row a rollback,
    suppression or branch switch removed, or an undo took out of the
    agent's window, is dropped, and so is a turn under way whose opening
    message, where its trigger read one, or own rows one removed, each
    ending with `inference:aborted`. The wakes that joined a dropped turn go
    back to the queue. An undo of the agent ends a waiting turn under way
    first, then runs. A waiting turn whose trigger
    has no row of its own, such as console input, a heartbeat or a merged
    wake whose messages read different rows, is checked only by the rows it
    has written, and one with none yet can't be checked and runs on what the
    surgery left, as a waiting wake does.
  - **When it ends without running:** if compression has nothing left to do
    and the context still doesn't fit, a released start that carried the
    note runs once more without it, and a refusal then takes the error
    policy's path. `abortInference()`,
    `stop()` and the agent's end drop a waiting turn, a released one before
    its start begins included, with `inference:aborted`. So does the
    inference policy declining a released turn's start, or the withdrawal
    of its wake.
- A closing conversation fork is no longer disposed while its closure wake
  waits, either when a turn of its that was alive at its expiry ends or by
  the fallback sweep, which also leaves it while a budget hold of its agent
  exists: the closure turn runs, and the fork is disposed after it.

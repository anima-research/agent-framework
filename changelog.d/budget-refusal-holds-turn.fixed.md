- A turn whose compile is refused for budget while compression is pending
  now waits, idle, and runs once compression has made room, instead of
  ending (#304). The refusal comes before the start's own provider call,
  for example after an immediate budget decrease. Before, the error policy retried it
  into the same refusal within seconds and ended the turn, and once
  compression had caught up nothing ran it again, so the agent stayed silent
  until its next wake. A refusal with nothing pending, an ephemeral run, and
  a framework that `start()` hasn't started fail as before.
  - **While it waits** the agent is idle: a surgery, a branch switch, an
    undo or a redo is admitted, a quiesce drains at once, and the wait holds
    no place in the event gate. A puppet call is admitted while a first
    start waits. While a turn under way waits, it's refused, naming
    `abortInference()` as the way to end that turn. `getHostModeStatus()`'s
    `gatedRequests` counts the waiting turn and the wakes that joined it.
    Wakes that arrive join the wait. For a turn's first start, their
    messages enter the agent's window as they arrive, and the released
    start answers them all, as a retry a provider hold kept answers those
    that joined it. For a budget restart's continuation or a tool-result
    guard's retry, they stay out of its request and run as a turn of their
    own after it.
  - **When it runs:** while no surgery holds the store and the host isn't
    quiesced, the waiting requests are queued again once something
    the refused compile depends on has changed: compression has made
    progress (a summary written since the refused compile started, or,
    for a strategy with no progress snapshot, a call that landed),
    compression has nothing left pending, a surgery's release or a
    completed undo, the agent's budget or live context settings have
    changed, or a quiesce has ended.
    Their start's own compile is the check. Refused again while compression
    is pending, they wait again, the note counting from the first wait's
    start, and each such start traces its own `inference:started` and
    `inference:failed`. A compression call that
    fails releases nothing. The wait drives compression itself, ticking the
    agent's context manager once, and again only while a strategy with no
    progress snapshot lands a call each tick; with the maintenance timer off
    it drives it again every 5 seconds. A compression
    call that fails in a tick it drives is reported as one in a maintenance
    pass is.
  - **What no request carried:** for an agent whose window is presented,
    its own stored context injections that no request has carried leave
    the window as a turn starts waiting, whichever attempt stored them, an
    earlier release's note included, and the released start stores them as
    it would without the wait. A routing notice the refused start stored
    stays, so its arrivals stay announced, and an undo of the released turn
    leaves it, unless the turn was a budget restart's continuation or a
    tool-result guard's retry, which store it after the turn's checkpoint.
  - **No time limit:** a turn can wait as long as compression stays
    pending.
    A waiting turn lives in memory, so a restart drops it, and the agent
    waits for its next wake, as after an exhausted turn before.
  - **Hosts watching for failed turns:** a turn that waits doesn't end in
    `inference:exhausted` or leave the `[inference-failed]` marker, as the
    refused turn did before. `inference:held` and `inference:hold_ended`,
    and `healthSnapshot()`'s `budgetHold`, show it waiting.
  - **The note:** as the wait releases, it stores "[budget-hold] Your
    context didn't fit its budget (100,201 tokens against 48,568) when a
    turn came to start. That turn waited 7 min." in the agent's window, as
    the agent's own stored context injection, counting from the first wait's
    start to the release, entering the window at once or, while a turn of
    the agent's is alive, at its next presentation point. The released start
    reads it where it was stored,
    so the next request starts with the same messages and a reply keeps its
    thinking, and later requests read it as history, which the strategy
    folds like any row. A failed write is logged, and the turn runs without
    the note. An undo of the released turn leaves the note, unless the turn
    was a budget restart's continuation or a tool-result guard's retry,
    which present it after the turn's checkpoint, so the undo takes it with
    the reply.
  - **A surgery or an undo:** a waiting turn whose trigger's row a rollback,
    suppression or branch switch removed, or an undo took out of the
    agent's window, is dropped, as is a released one whose row left the
    agent's window before its start began, whatever took it out, and so is
    a turn under way whose opening
    message, where its trigger read one, or own rows one removed, each
    ending with `inference:aborted`. The wakes that joined a dropped turn go
    back to the queue. An undo of the agent ends a waiting turn under way,
    and that turn's end is traced after the undo's own. A waiting turn whose trigger
    has no row of its own, such as console input, a heartbeat or a merged
    wake whose messages read different rows, is checked only by the rows it
    has written, and one with none yet can't be checked and runs on what the
    surgery left, as a waiting wake does.
  - **When it ends without running:** `abortInference()`, `stop()` and the
    agent's end drop a waiting turn with `inference:aborted`. Once released,
    a first start is a queued wake until its start begins, so an abort
    leaves it to run, and the inference policy or a withdrawal decides it
    as any queued wake; a continuation is a queued continuation, which an
    abort ends. If compression has nothing left to do and the context still
    doesn't fit, the released start's refusal takes the error policy's
    path, with the note in place. A released start that is then dropped,
    declined or withdrawn raises no `context-refusal-clear`, since its wait
    ended at the release.
- A closing conversation fork is no longer disposed while its closure wake
  waits, either when a turn of its that was alive at its expiry ends or by
  the fallback sweep, which also leaves it while a budget hold of its agent
  exists: the closure turn runs, and the fork is disposed after it.

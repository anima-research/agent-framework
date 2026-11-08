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
    the wait holds no place in the event gate. Wakes that arrive join the
    wait. For a turn's first start, their messages enter the agent's window
    as they arrive, and the released start answers them all. For a turn
    already under way (a budget restart's continuation, or a retry), they
    stay out of its request and run as a turn of their own after it.
  - **When it runs:** each time a compression call lands, a maintenance pass
    ends, or a quiesce ends, the waiting requests are queued, and their
    start's own compile is the check. Refused again while compression is
    pending, they wait again. The wait drives compression itself, ticking
    the agent's context manager while each tick starts a call, and with the
    maintenance timer off it looks again every 5 seconds. A compression call
    that fails in a tick it drives is reported as one in a maintenance pass
    is.
  - **The note:** the released turn reads "[budget-hold] Your context didn't
    fit its budget (100,201 tokens against 48,568), so this turn waited
    7 min for compression to make room." It's stored once that start's
    compile has gone through, where the compile placed it, so the next
    request starts with the same messages and a reply keeps its thinking. A
    start whose window doesn't end on the last `user` message gets no note,
    since a stored row would land elsewhere: a wake with nothing new, or a
    start that stored a context injection after the message.
  - **A surgery or an undo:** a waiting turn whose trigger's row a rollback,
    suppression or branch switch removed is dropped, and so is a turn under
    way whose own rows one removed, each ending with `inference:aborted`. An
    undo of the agent ends a waiting turn under way first, then runs. A
    trigger with no row of its own, such as console input, a heartbeat or a
    merged wake whose messages read different rows, can't be checked, and
    runs on what the surgery left, as a waiting wake does.
  - **When it ends without running:** if compression has nothing left to do
    and the context still doesn't fit, the start runs once more without the
    note, and a refusal then takes the error policy's path. `abortInference()`,
    `stop()` and the agent's end drop a waiting turn, with
    `inference:aborted`.

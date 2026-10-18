- With a budget, `stop(teardownTimeoutMs)` now also bounds its waits on the
  streams it cancels, on maintenance in flight and on the event loop, as it
  did its waits on an operator's operations and on modules and MCPL servers
  (#373). Each wait takes the whole budget, so a `stop()` with one can take
  up to five budgets, besides the withheld-spill deadline of a guard's write
  still under way. Before, a stream whose cancel couldn't reach it, a
  maintenance tick that didn't settle, or a module's `onProcess` that never
  returned kept `stop(t)` waiting without end, whatever `t` was. With no
  budget, `stop()` waits for each as before.
  - A wait whose budget runs out fails the `stop()` with a
    `ShutdownTimeoutError` naming what it waited for (`stream:<agent>`,
    `maintenance` or `event loop`), once teardown has gone on; with more
    than one, or beside another failure, the `stop()` fails with an
    `AggregateError` of them all. An owned store stays open, so that
    `stop()` can be called again, as after a timed-out wait on an
    operator's operations.
  - A later `stop()` waits again, within its own budget, for a stream or an
    event loop that an earlier one left running, and closes an owned store
    only once they've settled.
  - An agent whose stream outlasted its wait keeps its deferred writes
    queued, logged once for that agent, where `stop()` would otherwise
    store them ahead of what the stream may still write. The stream's own
    end takes them, as at any turn's end, if the process lives on, and a
    later `stop()` takes what that leaves. A memory-only queue loses them if
    the process exits before then.
  - Every ephemeral run still registered is ended with "refused: the
    framework is stopping", even one whose stream is still running, and its
    end stores what is queued for it, as at any run's end. Before, `stop()`
    waited for that run's stream first, without end if it never settled.
  - An event loop still in a call, such as a module's `onProcess`, when its
    wait runs out finishes that call and the rest of its iteration, then
    exits, even when a `start()` has been made meanwhile.

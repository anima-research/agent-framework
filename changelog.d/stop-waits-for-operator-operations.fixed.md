- **`stop()` waits for an operator's operation that is already running, and
  refuses new ones.** A quiesce, a resume, a
  `host/command`, a store surgery, a branch switch, an undo or redo's config
  materialization, a puppet tool call, an awareness sync, or an MCPL
  connect, disconnect or restart admitted before `stop()` began now
  finishes before the event gate, the modules, the MCPL connections and the
  store go, unless a budget runs out first (see the operators' note below).
  Before, such an operation kept running through the teardown. A resume
  waiting on its maintenance pass or previews could go on to leave quiesce
  while the host stopped, so the host booted unquiesced; a puppet call
  could find the store closed partway; a surgery could still be running at
  the final sync; a `host/command` could answer after its connection
  closed; an API server branch switch requested during `stop()` moved the
  branch, mounted its config after the store had closed and answered
  success; and a connect could leave a connection that nothing closed.
  - Once `stop()` has begun, `quiesce()`, `resume()`, `rollbackToMessage()`,
    `suppressMessages()`, `switchBranch()`, `undoLastTurn()`, `redo()`,
    `maintenanceTick()`, `puppetToolCall()`, `syncDiscordAwarenessMarkers()`,
    `connectMcplServer()`, `disconnectMcplServer()` and `restartMcplServer()`
    refuse with "<verb> refused: the framework is stopping" before they
    read or change
    anything, as a `host/command` already did. That includes a call made
    from a trace emitted inside `stop()`'s own start, before its queue has
    closed, and the MCPL listener now refuses a `host/command` from that
    moment too.
  - The awareness delivery that a surgery, a branch switch, a `host/command`
    undo, or the API server's undo or redo starts
    (`startDiscordAwarenessDelivery()`) runs like a server's drain: `stop()`
    doesn't wait for it, and once `stop()` has begun none is started, since
    the teardown would cut it off. The durable outbox keeps the marks, and
    the next start delivers them.
  - `stop()` also waits for what those operations start while it waits: the
    config materialization that undo, redo and the two surgeries start
    without waiting for it themselves. The framework now logs a failed
    materialization.
  - A quiesce stops waiting for its drain, or for an abandon's grace, once
    `stop()` begins. `stop()` cancels the streams and waits for the event
    loop and the operations above, puppet calls included. It doesn't wait
    for any other turn that holds its token with no stream to cancel, so a
    quiesce cut short can report `drained: false`. The host stays quiesced,
    so it boots quiesced. A drain cut short logs that it stopped waiting,
    emits no `host:quiesce` trace, and leaves an abandon it hadn't begun to
    `stop()`, which cancels the streams. An abandon whose grace is cut short
    reports its abandon as usual.
  - A resume refuses at its start once `stop()` has begun, whether or not
    the host is quiesced, and checks again after its maintenance and preview
    waits, before it leaves quiesce, so a quiesced host stays quiesced. A
    resume past that point finishes, its durable clear included, and its log
    says that the parked wakes it released won't run.
  - A host's trace listener can call `stop()` from inside an operation, such
    as on its completion trace, and `stop()` still waits for that operation.
    A multi-turn `host/command` undo stopped that way still undoes every
    turn it was asked for.
  - `undoLastTurn()` and `redo()` refuse with `OperatorActionError`
    (`agent-busy`) while a surgery or a branch switch holds the store,
    instead of moving the branch beneath it.
  - A `stop()` called from a trace emitted inside `stop()`'s own start, as
    the push coalescer's suspension emits for a render in flight, gets the
    attempt already running. Before, it started a second teardown beside
    the first, which then failed at its final sync, and every later
    `stop()` rejected with "Store has been closed" for a framework that had
    stopped.
  - While the host stops, an MCPL awareness barrier that fails no longer
    recycles the connections, which `stop()` is closing. The framework
    releases it as it releases a completed one, so nothing waits on a
    rejected barrier, and unless the host is quiesced, what it held back
    reaches the listeners' stopping refusal.
  - **For operators:** `stop()` waits as long as an operation's own work
    runs. An awareness drain finishes its deliveries, each within its own
    deadline, and a puppet call waits for its tool, so a tool on an MCPL
    server that never answers holds `stop()` until the request times out
    (60 s by default, never with `requestTimeoutMs: 0`).
    `stop(teardownTimeoutMs)` gives this wait its own budget, shared by all
    its rounds, and then gives the modules' and MCPL's teardown the budget
    again, so a budgeted `stop()` can take up to twice the budget, beside
    the stream and event-loop waits that no budget bounds. An operation
    that outlasts the budget fails `stop()` with a `ShutdownTimeoutError`
    that names it, on its own or inside an `AggregateError` when other
    cleanup failed too. `stop()` still tears down the rest, while that
    operation may still run, and keeps the store open, so `stop()` can be
    called again.

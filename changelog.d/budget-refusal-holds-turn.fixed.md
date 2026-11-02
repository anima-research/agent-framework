- A turn whose compile is refused for budget waits for compression and then
  runs, instead of ending (#304). The refusal comes before any provider call,
  for example after an immediate budget decrease. Before, the error policy
  retried it into the same refusal within seconds and ended the turn, and once
  compression had made the context fit, nothing ran it again, so the agent
  stayed silent until its next wake. Now a resident's or a conversation
  agent's turn is held while its context manager has compression pending, and
  later wakes join it. The hold leaves the provider gate open and drives
  compression itself: from its start it ticks the agent's context manager
  while a call of that manager's starts during each tick, so it doesn't wait
  for a maintenance pass, and it drives it again after each pass (with the
  maintenance timer off, every 5 seconds) and when a call of that manager's
  lands while the turn is held, unless a drive of the hold's own or a drain it
  joined is under way, whose end looks again; for a call that lands during
  another drain, such as the OverBudget drain breaker's, the hold looks and
  drives once that drain ends. A tick that starts no call, as while
  compression is paused after a failure, ends that drive. An ephemeral run, a
  turn in a framework that `start()` hasn't started (only `runUntilIdle()`
  runs its turns, so nothing would run a released one), and a refusal with
  nothing pending fail as before. What a held turn changes for hosts is under
  Changed.
  - **When it runs:** as one fresh compile, once context-manager's preview of
    that compile, at its budget and with its thinking binding, says it fits. A
    dry compile can't say so, since it can resolve a plan the turn's compile
    refuses. A refusal the preview rethrows, such as a context refusal, counts
    as a refusal. A strategy with no preview gets the dry compile. The
    hierarchical strategy's preview reports a context that doesn't fit, and
    for one that does, the dry compile decides. The hold looks after each tick
    it drives that starts a compression call, so a call that makes the context
    fit releases the turn at once, and looks again when each drive, or drain
    it joined, ends, when a call of that manager's lands outside them (during
    a drain it hasn't joined, once that drain ends), and after each
    maintenance pass. After a compression call returns, its chunk's quarantine
    clean-up can still run under the compression-state lock; a hold that
    looked during that clean-up, with more compression still needed, is looked
    at again at the next maintenance pass, at the hold's recheck with the
    maintenance timer off, or when another call of that manager's lands. With
    the maintenance timer on, once the hold's own drive has ended, the hold
    drives compression again at a pass's end or when a later call of that
    manager's lands, so a pass that never ends, with no other call of that
    manager's landing, keeps the turn held until the turn is ended, as by an
    abandoning quiesce, `abortInference()` or a stop; with the timer off, so
    does a tick of the hold's own that never ends. It takes a fresh verdict
    only once something that could make the context fit has changed:
    compression's progress or whether it still has compression pending, a
    message added, edited or removed (other than the arrival of a stored
    context injection, the hold's own note among them, or of a clock row), the
    agent's runtime settings, or the budget its next compile plans at. A turn
    released and refused again is held again, as of the refusal that first
    held it, and isn't released again until one of those changes.
  - **When it ends without a fit:** once compression has nothing pending and
    the context still doesn't fit. The turn then compiles once more: it runs
    if that compile fits, and otherwise its refusal takes the error policy's
    path, as a refused compile did, its reason saying when it was first held.
    The hold has no time limit, since the turn can't run before its context
    fits. Compression can stay pending without moving, and the turn stays
    held through that, and runs once a check finds its context fits:
    - **Calls that keep failing:** with context-manager 0.24.1, when every
      compression call fails for a reason that says nothing about the
      request, as in an outage of its model's provider or with bad
      credentials, it waits between tries from 5 seconds doubling up to 10
      minutes and tries again on later ticks. Each failure raises
      `context-maintenance-failed` under maintenance's rule for repeats, and
      the hold ends by itself once a call succeeds and the context fits.
    - **A wait with no end:** after a call whose provider states a wait that
      can't be held as an instant, the framework records it as a wait until
      released, which raises one `provider-wait` ops alert and holds the
      agent's calls on that model, compression's included, and the lane
      makes no call. `releaseProviderWait()` lifts that wait and the lane's
      pause together. The wait is recorded in the store, so a restart doesn't
      lift it, and a restart drops the held turn.
    - **Work nothing bounds:** compression whose pending work isn't a call,
      such as a quarantine clean-up under the compression-state lock that
      never ends, keeps the turn held with no signal of its own. A chunk or a
      merge blocked by a message held from compression waits too; this
      framework holds a message only as it stores it, which blocks no chunk
      or merge already made, so only a host's own later hold meets that.
    - **Outside the framework's alerts:** a strategy that drains compression
      on new messages by itself (`autoTickOnNewMessage`, which this framework
      doesn't set) reports that drain's failures in context-manager's own
      log only.
    The hold lives in memory: a restart drops it, and the agent's next wake
    compiles afresh.
  - **Undo:** a hold adds no undo step. When the refused start recorded a
    checkpoint, as a turn's first start does, the start the hold releases
    moves it to after the messages that arrived while the turn waited, so the
    undo keeps them, as it keeps the context injections the refused start
    stored, and a hold that's stopped leaves it where it was. When a retry is
    refused, an error policy's or a tool-result guard's, the turn keeps the
    checkpoint its first start recorded, before what it had done, and the undo
    takes the messages that arrived while it waited too. The redo its new work
    invalidated stays invalidated, as at any turn's first start.

- `stop()` now runs every step of its teardown whatever an earlier step did.
  Before, a step that threw, such as a host's stream whose `cancel()`
  throws, ended `stop()` there: its modules and MCPL servers weren't
  stopped, the liveness watchdog went on beating, the framework stayed in
  the diagnostics registry, an ephemeral run still pending wasn't ended,
  and every later `stop()` failed the same way. Now `stop()` fails with
  that error once the rest has run, beside any other failure in an
  `AggregateError`, and an owned store stays open for another `stop()`, as
  after a failed module stop. A step in the last flush of deferred writes,
  which comes once everything else has stopped, fails the `stop()` as a
  failed final sync does, and the store is still synced and closed.
  - A stream whose `cancel()` threw is left running, as one whose wait ran
    out is: `stop()` doesn't wait for it, even with no budget, its agent's
    deferred writes stay queued, and a later `stop()` waits for it before
    it closes the store.
  - An ephemeral run whose own stream's `cancel()` throws at the run's end
    now leaves all the same, and settles as it ended, such as with
    `stop()`'s refusal, rather than with the cancel's error, which is
    logged. Before, the throw skipped the run's cleanup: the run and its
    agent stayed registered, and the stream's later text still reached the
    agent's context.
- `stop()` now ends Discord awareness delivery. A drain running when
  `stop()` begins sends nothing more, and the marks it hasn't sent stay
  pending in the outbox, unrecorded, for the next start's barrier; a line in
  the host log names the server and how many marks it held. `stop()`
  waits, within `teardownTimeoutMs`, for each drain still running to record
  the call that closing its MCPL server ended. Before, `stop()` neither
  stopped nor waited for drains: once the servers had closed, a drain went
  on through its pending marks, recording each as a failed attempt
  ("Cannot send request: connection … is closed") though it sent none, and
  with many marks those writes went on after `stop()` had returned. After a
  `create()` whose awareness barrier failed on one server, another server's
  drain went on writing the outbox after `create()` had rejected, while a
  `create()` retried in the same process could already be using it.
  - A wait on drains that runs out fails the `stop()` with a
    `ShutdownTimeoutError` naming `awareness drain:<server>` and keeps an
    owned store open; a later `stop()` waits for that drain again. With a
    budget, a `stop()` can now take up to six budgets, where 0.22.3 took up
    to five. A failed `create()` gives this wait 30 s too, a third cleanup
    wait beside the two it had in 0.22.3.

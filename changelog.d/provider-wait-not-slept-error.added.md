- `ProviderWaitNotSleptError`: when a retryable provider failure states a
  wait an ephemeral run won't sleep (longer than the 600 s it sleeps in its
  turn, infinite, or `NaN`), `runEphemeralToCompletion` now rejects with this
  error, carrying the wait as stated as `retryAfterMs`. Its message is
  unchanged. Its `name` is `ProviderWaitNotSleptError`, so a logged rejection
  reads that where it read `Error`. A host that decides whether to run a task
  again can test `instanceof` or the `name` instead of reading the message.
  Every other ending still rejects with a plain `Error`.

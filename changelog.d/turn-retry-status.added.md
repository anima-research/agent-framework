- **`healthSnapshot()` says when a turn is alive and when it is waiting to retry.** Each agent entry gains
  `turnAlive` (a turn's continuation is on its way, as the scheduler reads it) and `retrying`: while the turn waits
  out its error policy's delay, `{ since, until, nextTry, maxTries?, retryClass? }`, otherwise `null`. `status` is
  unchanged, and between a failed call and its retry it still reads `idle`, since the failed call reset the agent's
  state; the two new fields say what it doesn't. A resident whose provider answered `overloaded_error` for eight
  minutes read `idle` throughout, while its turn retried and a newer message waited in the gate's buffer.
  `inference:waiting` carries the same `nextTry`, `maxTries` and `retryClass`. `nextTry` is the error policy's place in
  its schedule, the count `maxTries` bounds: every failed start counts, whether or not it reached the provider, and a
  provider hold that queues the turn again starts the count over. It is not a count of sends.
- **`ErrorAction` may say what the policy retries a failure as.** A retry action takes optional `retryClass` (such as
  `overloaded`) and `maxTries` (the most tries that class allows, the first included). They are shown, not acted on.
  `DefaultErrorPolicy` always fills `retryClass` with the class it decided by, and fills `maxTries` when that class's
  schedule has a bound (`maxAttempts: null` leaves it out). An `overloaded` failure under settings with no overloaded
  schedule takes `retryable`'s, as membrane does. A policy that leaves both out is shown with the try number alone.

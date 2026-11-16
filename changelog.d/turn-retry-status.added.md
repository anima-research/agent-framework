- **`healthSnapshot()` says when a turn is alive and when it is waiting to retry.** Each agent entry gains `turnAlive`
  (a turn holds its token, or its continuation or retry is on its way, as the scheduler reads it) and `retrying`:
  while the turn waits out its error policy's delay, `{ since, until?, nextTry, maxTries?, retryClass? }`, `until`
  absent for a wait with no end date, otherwise `null`. A retry a provider hold keeps (a stated wait, an acceleration
  limit or a host's hold) reads `retrying: null`, and `providerAdmission` shows the hold (`cooldownUntil`,
  `cooldownReason`, `hostHold`). `status` is unchanged, and between a failed call and its retry it still reads `idle`,
  since the failed call reset the agent's state; the two new fields say what it doesn't. A resident whose provider
  answered `overloaded_error` for eight minutes read `idle` throughout, while its turn retried and a newer message
  waited in the gate's buffer. `inference:waiting` carries the same `nextTry`, `maxTries` and `retryClass`. `nextTry`
  is the error policy's place in its schedule, the count `maxTries` bounds: every failed start counts, whether or not
  it reached the provider, and a provider hold that queues the turn again starts the count over. It is not a count of
  sends.
- **`ErrorAction` may say what the policy retries a failure as.** A retry action takes optional `retryClass` (such as
  `overloaded`; one longer than 128 characters is shown as its start and end around a note of how much was left out)
  and `maxTries` (the most tries that class allows, the first included, shown only as a positive whole number). They
  are shown, not acted on. A turn re-armed after it ran out of tries ends at its second deadline expiry with no
  completed round, transient failure or message said to it between them, whatever `maxTries` says.
  `DefaultErrorPolicy` always fills `retryClass` with the class it decided by, and fills `maxTries` when that class's
  schedule has a bound (`maxAttempts: null` leaves it out). An `overloaded` failure under settings with no overloaded
  schedule takes `retryable`'s, as membrane does. A policy that leaves both out is shown with the try number alone.

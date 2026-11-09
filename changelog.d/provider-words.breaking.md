- **Hosts that tell a failed ephemeral run apart by its rejection's
  message:** `runEphemeralToCompletion` now rejects a failed turn with the
  framework's words, such as "the model call failed (server, HTTP 529)",
  where 0.33.0 rejected with the failure's own message. A host that looked
  for a provider's words there, such as "overloaded", no longer finds them.
  The failure's own message, and from a MembraneError its `type`,
  `retryable`, `httpStatus`, `providerErrorCode` and `retryAfterMs`, are on
  the rejection's `cause`.
- **Hosts that recognize the rewind marker by its tag:** the marker opens
  with `[turns-set-aside]` where it opened with `[refusal-rewind]`. Its
  row's metadata still has `kind: 'refusal-rewind'`.

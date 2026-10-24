- **Hosts and custom `errorPolicy` authors:** the framework is now the one
  retry layer for its turns. A turn passes `retry: false` to membrane, so
  membrane sends a failed round once and the error reaches the framework,
  where since membrane 0.7 membrane's own schedules (up to ten minutes at a
  529) ran inside each of the framework's attempts, out of its sight. Each
  retry is now a fresh compile, its wait is traced, and a stop cancels it.
  The default error policy decides on membrane's schedules
  (`@animalabs/membrane/retry`; `MEMBRANE_RETRY_SETTINGS` unless a host
  passes `new DefaultErrorPolicy(settings)` as `errorPolicy`), where it
  retried any retryable failure three times, 1, 2 then 4 s apart:
  - a 529, or an overloaded error mid-stream, gets the overloaded schedule:
    seven tries, jittered waits from 10 s doubling to five minutes;
  - a 429 gets at least five tries on the base schedule;
  - any other retryable failure, a stream deadline included (membrane itself
    leaves a deadline to its caller), gets three tries, 1 s then 2 s, and so
    does an error that isn't a MembraneError;
  - a provider's stated wait is waited when it is longer than the backoff, up
    to ten minutes (the framework's provider-hold cap), as before;
  - a failure that isn't retryable ends at once, as before.
  A custom `ErrorPolicy` now sees failures membrane used to retry first (a
  5xx, a 529, a dropped connection, a 429), so it decides those itself.
  **Migration:** decide with membrane's own helpers (`classifyFailure`,
  `retryDecision`), as the default policy does, or wrap the now exported
  `DefaultErrorPolicy`. **Unchanged:** the provider holds before the policy
  (a resident's stated waits and acceleration 429s), refusal re-issues
  (`refusalRetries`), a direct caller of `Agent.startStream` (it keeps
  membrane's retries; `ActivationRequestOptions.membraneRetries: false` is
  what the framework passes), and calls that aren't turns (the MCPL
  inference router, compression and other host calls keep membrane's
  retries).

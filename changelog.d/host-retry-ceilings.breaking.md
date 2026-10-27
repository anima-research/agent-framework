- **Hosts that pass `new DefaultErrorPolicy(settings)` as `errorPolicy`:**
  the policy now takes your settings' stated-wait ceilings as they are
  (agent-framework#734). 0.27.0 raised each class's ceiling below the
  framework's ten-minute provider-hold cap to that cap, so with a ceiling of
  30 s the policy still retried a 429 stating a 90 s wait. Now it answers no
  retry, as your settings say, and the turn ends. The policy decides such a
  failure for an ephemeral run's turn, such as a subagent's, and
  `runEphemeralToCompletion` then rejects with a plain `Error` carrying the
  provider's words: `ProviderWaitNotSleptError` still means only a wait past
  the framework's ten-minute cap, or one it can't represent. A resident's or
  a conversation agent's stated wait is held by the framework before the
  policy is asked, as in 0.27.0. **Migration:** to keep 0.27.0's behaviour,
  raise each class's `statedWaitCeilingMs` that isn't `null` to at least
  600,000, as 0.27.0 did. The default policy's own settings keep the
  ten-minute ceilings.

- **Hosts that pass `new DefaultErrorPolicy(settings)` as `errorPolicy`:**
  the policy now takes your settings' stated-wait ceilings as they are
  (agent-framework#734). 0.27.0 raised every class's ceiling to the
  framework's ten-minute provider-hold cap, so a ceiling of 30 s still
  retried a 429 stating a 90 s wait. Now such a failure ends the turn, as
  your settings say. **Migration:** to keep 0.27.0's behaviour, raise each
  class's `statedWaitCeilingMs` that isn't `null` to at least 600,000, as
  0.27.0 did. The default policy's own settings keep the ten-minute
  ceilings.

- **Wake onboarding doesn't ask about the servers a store already had.** A
  host updated from a release without onboarding (0.32.0 or earlier) got a
  `[wake onboarding]` notice, and for an event that waits on the agent a
  wake, for every MCPL server whose events one of its catch-all rules lets
  by: all of its servers at once, on the day of the update, though its agent
  had written its rules with those servers there. Now the first start that
  finds a `gate.json` and no `wake-decisions.json` records the servers it is
  configured with as predating onboarding, and each is settled as `unasked`
  at its first undecided event, with no notice and no wake (trace
  `gate:onboarding-decided` with `state: "unasked"`). Nothing else changes
  for them: `event_tags` shows their suggestions, `wake_accept_suggestions`
  and `wake_decline` answer them, and a changed declaration is asked about as
  any server's is. A server added after that start is offered as before, and
  so is every server of a new store. `wake-decisions.json` is now written at
  the first start, even with nothing decided, so that its absence means
  onboarding has never started on the store; it gains a `predating` list
  while any of those servers is unsettled, and `unasked` among its states. A
  host that already started 0.33.0 and has a `wake-decisions.json` is not
  affected; one that started it and has none yet (no server's event was
  undecided) treats its next start as that first one.

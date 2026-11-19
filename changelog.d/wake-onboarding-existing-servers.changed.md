- **Wake onboarding doesn't ask about the servers a store already had.** A
  host updated from a release without onboarding (0.32.0 or earlier) to
  0.33.0 or 0.34.0 got a `[wake onboarding]` notice, and for an event that
  waits on the agent a wake, for every MCPL server whose events one of its
  catch-all rules lets by: all of its servers at once, on the day of the
  update, though its agent had written its rules with those servers there.
  Now the first start that finds a `gate.json` and no `wake-decisions.json`
  records the servers it is configured with as predating onboarding, and each
  is settled as `unasked` when it sends its first event, against what it
  declares then, whatever the gate later decides about that event, with no
  onboarding notice or wake (trace `gate:onboarding-decided` with
  `state: "unasked"`). A server whose declarations can't be read when an
  event comes is settled at a later event that finds them. A store that ran
  0.33.0 or later with `gate.onboarding: false` and has a `gate.json` is
  treated the same way when onboarding is turned on. Nothing else changes for
  them: `event_tags` shows their suggestions, `wake_accept_suggestions` and
  `wake_decline` answer them, and a changed declaration is asked about as any
  server's is. A server added after that start is offered as before, and so
  is every server of a new store. `wake-decisions.json` is now written at the
  first start, even with nothing decided, so that its absence means
  onboarding has never started on the store; it gains a `predating` list
  while any of those servers is unsettled, and `unasked` among its states. A
  host that already started 0.33.0 or 0.34.0 and has a `wake-decisions.json`
  is not affected; one that started either and has none yet (no server's
  event was undecided) treats its next start as that first one. A decisions
  file that can't be read is set aside and written anew, empty, at once:
  onboarding had started there, so no server predates it.
- **0.33.1, 0.33.2 and 0.33.3 have this change, and 0.34.0 doesn't.** A host
  on one of them that went to 0.34.0 dropped its `unasked` records and its
  `predating` list when 0.34.0 first wrote `wake-decisions.json`, such as at
  its first offer, and those servers were offered there. This release can't
  bring them back. Where 0.34.0 wrote no decision, this release finds the file
  as the 0.33 release left it. A host on one of them that comes straight to
  this release keeps them. Going back to 0.34.0 or 0.33.0 without restoring
  the store's files drops them, and those servers are offered.

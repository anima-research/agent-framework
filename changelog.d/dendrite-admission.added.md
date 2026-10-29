- The admission stage (Dendrite §D, issue #232 §3.5): every inbound channel
  message and push event passes one decision — captured, recipients, body or
  hold, wake, locus — before anything acts on it (`src/admission/admit.ts`,
  traced as `admission:decided`). The wake gate runs after the hold, so a
  held message never forms a debounce batch; for a held message it is only
  probed, and that verdict preconditions the reader's wake. Gate batches
  re-check the hold at delivery (`gate:held-dropped`).
- `speech.locus` (`'delivery'` | `'latest-inbound'`): where plain prose goes
  when nothing names a destination. The default `'delivery'` is the §3
  carve-out: only the waking delivery, a fork's home or a channel the agent
  opened this turn sets the locus; incoming traffic never moves it, between
  turns or mid-turn; a turn without one keeps its prose private with a
  `[routing]` notice. `'latest-inbound'` restores the previous rule.
- Tune-out without a reader (#232 §3.3): the coordinator exists whenever
  MCPL channels do, a persisted epoch is always resumed and released, and a
  tune-out without a subconscious is a silent hold. `tuneOut.enabled` offers
  `tune_out` to residents when no reader is configured.
- `tune_out` and `cancel_tuneout` take `serverId`; a channel id that exists
  on several servers is refused as ambiguous.

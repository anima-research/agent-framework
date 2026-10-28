- Issue #232 §2 tune-out gaps, each with a regression test (gaps 1 to 10 on
  the loopback MCPL server in `test/admission-e2e.test.ts`, gap 11 in
  `test/tune-out-dump-fit.test.ts`): tuning out a DM now holds it
  (1); held traffic never moves the speech locus (2); a debounced mention in
  a tuned-out channel wakes the reader, not the resident (3); a release names
  non-text blocks instead of dropping them (4); a held message that arrives
  mid-turn is stored, never injected into the live turn (5); a release left
  in the deferred queue is durable and re-wakes the resident at boot (6);
  held messages still deferred at cancel are in the release (7); channel ids
  resolve server-qualified (8); `channel_close` on a tuned-out channel is
  refused, and the tune-out's cancel releases (9); the hold machinery runs
  without a reader (10); the truncation note names a history tool the
  resident has, or none (11).

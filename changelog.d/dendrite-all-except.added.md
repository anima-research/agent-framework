- The all-except scope (issue #232 §3.2; focus folded into tune-out):
  `tune_out` with `scope: 'all-except'`, or its alias `focus`, holds every
  channel except one — DMs and channels registered later included — for a
  mandatory `durationSeconds`. A turn with no delivery of its own speaks into
  the excepted channel. `mode: 'check'` reports held counts per channel and
  peeks one channel without releasing; release is per channel, each capped.
  A per-channel epoch takes precedence; the reader may end the scope;
  exhausting the reader's wake budget pauses reader wakes rather than ending
  the hold (`tune-out:wake-budget-paused`); closing the excepted channel ends
  it. Listed by `listPolicyEpochs()` as `{ kind: 'all-except', except }`.
  Entry and release are announced in the excepted channel as one bracketed
  line each under the resident's name (`tuneOut.announce`, default true;
  traced `tune-out:announced` / `tune-out:announce-failed`).
  Its end time and cadence hold any length: both run on timers no longer
  than one holds, as a channel's tune-out does since 0.22.2, so a hold or a
  cadence past 24.8 days ends or ticks when it should rather than at once.
  `focus` reads its options as `tune_out` does: a value that gives no finite
  number is refused, naming it, before anything changes; a numeric string is
  read as its number; a `null` option counts as left out; and the duration
  is still required.

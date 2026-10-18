- A tune-out's `durationSeconds` or `cadenceSeconds` longer than about 24.8
  days (2^31 - 1 ms, the longest delay one Node timer holds) now holds.
  Before, Node fired the timer almost at once, so such a tune-out ended as
  "duration elapsed" moments after it began, waking the resident with its
  backlog, and such a cadence re-armed about every millisecond, giving the
  subconscious a turn as soon as anything was diverted. Both timers now
  wait in steps no longer than one timer. The cadence counts its period on
  those timers, as it did before, so setting the wall clock doesn't move
  it. The end time reads the wall clock against the stored end at each
  step, so a host that runs through a long tune-out and one that restarts
  during it aim at the same end.
- A tune-out that ends in the channel registry without a cancel (the send
  path and the close tool set the channel's state there directly) no
  longer leaves its timers to act on the channel's next tune-out. Before,
  when the next tune-out had no `durationSeconds`, the old end time ended
  it as "duration elapsed", and a wake still in its 2-second coalescing
  window counted against it and gave the subconscious a turn.
- `tune_out` refuses a `durationSeconds`, `cadenceSeconds`, `backlogCap` or
  `maxWakes` that gives no finite number, such as `"abc"`, and a duration
  whose end time is too far off to store, naming the option and saying
  nothing was tuned out, before anything changes. Before, the store's write
  threw after the channel had been marked tuned out in memory, so the call
  failed and left the channel diverted with no cadence or end timer until
  the next restart. A numeric string such as `"3600"` is still read as its
  number.
- A `null` `durationSeconds` now means the tune-out lasts until cancelled,
  as leaving it out does. Before, it gave a tune-out of 60 seconds, the
  shortest duration.

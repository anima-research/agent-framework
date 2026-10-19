- On a host with no primary (`agents: []`), a write with no target goes to the
  first registered agent, such as an ephemeral run. Deferred, it now names
  that agent in its queue entry, so it is that agent's as a targeted write is:
  the agent's own flushes store it, and so does its window's release when it
  leaves. Before, the entry named no agent, so neither the run's flushes nor
  the run's end took it: after the run it was still queued, unstored, and in
  the recovery file when the queue was persisted.
- Boot recovery numbers the restored deferred-write queue 1, 2, 3, … in the
  order it restores it, and later deferrals are numbered on from there.
  Before, it kept each entry's `seq` and numbered only the entries without a
  valid one, after the largest, so the counter went on from the largest valid
  `seq`: one at `Number.MAX_SAFE_INTEGER`, which boot accepts, gave every
  later deferral the same `seq`, 2^53. A recovery file whose `seq`s are all
  valid isn't rewritten at boot for the new numbers; the queue's next write
  carries them.
- At a tool boundary, a deferred message that the strategy stores as more than
  one message (a sharded body) is now injected as later compiles render it,
  its shards joined. Before, it was injected as given, so a body of more than
  one text block, or with a non-text block after a text block, reached the
  stream in a different shape from later requests.

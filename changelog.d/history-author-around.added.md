- History tools, from a resident's diary-work feedback: `search` and `extract`
  take `author` / `excludeAuthor` (exact, case-insensitive match on
  `metadata.author` name or id; messages without author metadata, such as
  the agent's own turns, match on their stored participant). Results now carry `author`.
  `extract({aroundId, before, after})` returns the conversation around a
  message id from `search` (its own channel by default, `allChannels` to
  interleave). `search` adds `wholeWord` (Unicode-aware) and
  `order: "newest"`, and when it stops early (at `limit` or `maxScan`) it
  reports `scannedThrough` plus a hint naming the `from`/`to` to continue with.
  An author-filtered `extract` that stops early returns
  `resume: {windowOffset, offset}` to repeat the call with (position, not
  timestamp, so late-appended backfill in a channel is not skipped).

- History tools, from a resident's diary-work feedback: `search` and `extract`
  take `author` / `excludeAuthor` (exact, case-insensitive match on
  `metadata.author` name or id, or the stored participant for the agent's own
  turns; MCPL-ingested messages are all participant `user`, so participant
  alone could not tell authors apart). Results now carry `author`.
  `extract({aroundId, before, after})` returns the conversation around a
  message id from `search` (its own channel by default, `allChannels` to
  interleave). `search` adds `wholeWord` (Unicode-aware) and
  `order: "newest"`, and when it stops early (at `limit` or `maxScan`) it
  reports `scannedThrough` plus a hint naming the `from`/`to` to continue with.

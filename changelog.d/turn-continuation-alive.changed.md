- `stop()` ends a turn whose continuation hasn't started, as `shutdown`,
  with the continuation dropped.
- `inference:stream_restarted`, and the restart boundary's usage report, now
  come after the restart's continuation is queued and its stream cancelled.
  A restart boundary reached while the framework is stopping emits no
  `inference:stream_restarted` and queues no continuation: the turn ends as
  `shutdown`.

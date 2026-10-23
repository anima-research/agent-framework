- `stop()` ends a turn whose continuation hasn't started, as `shutdown`,
  with the continuation dropped.
- A budget restart's `inference:stream_restarted`, and its boundary's usage
  report, now come after its continuation is queued and its stream
  cancelled.
  A restart boundary reached while the framework is stopping emits no
  `inference:stream_restarted` and queues no continuation: once the stream's
  cancel goes through, the turn ends as `shutdown`.

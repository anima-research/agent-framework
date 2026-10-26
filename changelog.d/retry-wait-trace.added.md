- **Hosts:** a turn waiting out its error policy's delay before a retry now
  says so with an `inference:waiting` trace event: as the wait begins, with
  `until`, the time the wait is due to end, and again every 60 seconds
  while it lasts, while its agent is the one registered under its name, and
  never after the wait ends. The failure being retried is the `inference:failed`
  just before it. A host that watches for agents gone quiet can tell a
  waiting one from a stuck one: connectome-host 0.14's subagent reaper
  reclaims a subagent that has been silent for two minutes with no request
  in flight, and `inference:failed` ends its request in flight, while the
  default policy's waits before a 529's fifth and later retries run from 80
  seconds to five minutes.

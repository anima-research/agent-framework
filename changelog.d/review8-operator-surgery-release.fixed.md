- A surgery's release (a rollback, a suppression, `switchBranch()`) now
  replays the writes its hold kept one at a time, and the store counts as
  held until the last one is stored. A tune-out cancel that a trace
  listener asks for during the replay waits for its end, as during the
  hold, so its backlog has every held message. Before, the release took
  every write off the queue first: a cancel asked for then ran at once
  and dumped its backlog without the messages still to replay. During the
  replay, `HostModeStatus.deferredWrites` counts the writes still waiting,
  and a write made then is stored after them.

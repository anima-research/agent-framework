- Agents with `proseRouting: 'disabled'` now show the typing indicator during
  a turn, on the channel the trigger came from, the same as explicit mode. A
  batched gate wake names no `channelId`, so its `wakeChannelId` is used
  instead. Before, disabled-mode turns showed no indicator at all, so a
  resident that answers only through send tools looked idle while it worked.
  Never on a tuned-out channel: the agent turned its attention off there, yet
  an ambient push or a gate wake can still name the channel. Silent wakes
  (`suppressProse`, such as a silent heartbeat) still show none. Explicit and
  locus modes pick their typing channel as before.
- Entering tune-out on a channel now stops a typing indicator already running
  there. Before, its 7 s refresh continued until the turn ended. A
  disabled-mode turn does not restart it; an explicit or locus turn can still
  restart it at stream start or on a retry, as before.

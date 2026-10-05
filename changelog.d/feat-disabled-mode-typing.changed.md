- Agents with `proseRouting: 'disabled'` now show the typing indicator during
  a turn, on the channel the trigger came from, the same as explicit mode. A
  batched gate wake names no `channelId`, so its `wakeChannelId` is used
  instead, unless that channel is tuned out (its ambient traffic can reach
  the gate before tune-out diverts it). Before, disabled-mode turns showed no
  indicator at all, so a resident that answers only through send tools looked
  idle while it worked. Silent wakes (`suppressProse`, such as a silent
  heartbeat) still show none. Explicit and locus modes are unchanged.

- An ephemeral run (a subagent) no longer posts its plain prose to whichever
  channel last received a message (#551). That channel, the process-global
  fallback, was the locus of any `locus` or `hybrid` run with no channel of its
  own, so delegated work, possibly drawn from a DM, could land in an unrelated,
  possibly public channel. No ephemeral run takes the global fallback now,
  whatever its prose routing:
  - a `locus` or `hybrid` run's plain prose with no channel of its own is
    returned to its caller as before and published nowhere; a sleep
    announcement it makes is published nowhere too. Neither counts as a failed
    delivery, so neither writes a `[send-undeliverable]` notice, an
    `mcpl:speech-route-failed` trace or a log line;
  - `channel_publish` without a `channelId` is refused, with words saying to
    name the channel;
  - its channel context has no `incoming` message, and no default outgoing
    channel unless it opened one itself;
  - a refusal of its inference adds no reaction anywhere, and its
    `failures.log` record names no `locus`.

  A channel the run opens itself, and a destination it names in its prose
  (`hybrid`'s `>>>`, `explicit`'s `>>`), still route as before. Residents and
  conversation forks keep the fallback. `channel_publish`'s description now
  says where an omitted `channelId` goes: the conversation's bound channel,
  else the most recent incoming one, and nowhere for a subagent.

- A failed open no longer stops the agent's speech. Speech into a closed channel whose open fails,
  as on a dead transport, is still published. Before, the open that preceded publishing threw, and
  the speech failed with "locus channel is closed and open failed". A send tool's call was already
  published before its open. On a server whose grant lacks `channels.lifecycle`, where no channel
  can open, speech now publishes without trying to open the channel, and records no intent to
  open it. Before, it recorded that intent, and then failed.
- A publish that throws, as on a dead transport, is now a failed route. The agent gets the
  `[discord-send-failed]` marker, and `mcpl:speech-route-failed` is traced. Before, the framework
  only logged it.
- A send tool's call into a tuned-out channel no longer ends the tune-out. It used to set the
  channel's decision to open, which ended the tune-out epoch, and announced "[channels] Now open".
- The agent's `channel_close` or `channel_decline` of a channel nobody had decided about, which
  is closed by default, or of one a machine closed, is now recorded as its decision, so neither
  subscription policy, a server's `initiallyOpen` nor the agent's own speech there opens it later.
  Before, the channel kept its default, which policy and `initiallyOpen` lift, or the machine's
  source. A machine close of a channel nobody decided about,
  such as connectome-host's `subscription-gc`, still records no decision: the channel keeps its
  default, so policy can still open it. That now holds for a channel with no record at all, one
  registered lazily or on a server whose grant lacks `channels.lifecycle`, where a machine close
  used to record its own source, which policy never lifts (#417).
- `channel_close`'s description and the "[channels] Now open" notice's last sentence now say that
  a channel the agent closes stays closed until it opens it with `channel_open`, and that neither
  speaking there nor policy reopens it.
- The closed-channel invitation is no longer added to a direct message (`chat:dm`), all of which
  reaches the agent whether the DM is open or not. Where no single-word target reaches a channel,
  it no longer says that replying needs a join: it suggests checking whether the server has a
  send tool that can address the channel.

- A send tool's call into a tuned-out channel no longer ends the tune-out. It used to set the
  channel's decision to open, which ended the tune-out epoch, and announced "[channels] Now open".
- Speech into a closed channel on a server whose grant lacks `channels.lifecycle` now publishes.
  Before, the open that preceded publishing threw, and the speech failed.
- `channel_close` and `channel_decline` on a channel nobody had decided about, which is closed by
  default, now record the agent's decision. Before, the channel kept its default, so subscription
  policy or a server's `initiallyOpen` could open it later.

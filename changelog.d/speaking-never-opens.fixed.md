- A send tool's call into a tuned-out channel no longer ends the tune-out. It used to set the
  channel's decision to open, which ended the tune-out epoch, and announced "[channels] Now open".
- Speech into a closed channel on a server whose grant lacks `channels.lifecycle` now publishes.
  Before, the open that preceded publishing threw, and the speech failed.
- The agent's `channel_close` or `channel_decline` of a channel nobody had decided about, which
  is closed by default, is now recorded as its decision. Before, the channel kept its default,
  so subscription policy or a server's `initiallyOpen` could open it later. A machine close of
  such a channel, such as connectome-host's `subscription-gc`, still records nothing, so policy
  can still open it.

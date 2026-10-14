- A send tool's call into a tuned-out channel no longer ends the tune-out. It used to set the
  channel's decision to open, which ended the tune-out epoch, and announced "[channels] Now open".
- Speech into a closed channel on a server whose grant lacks `channels.lifecycle` now publishes.
  Before, the open that preceded publishing threw, and the speech failed.

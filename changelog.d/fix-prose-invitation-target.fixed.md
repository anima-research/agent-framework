- The closed-channel invitation's "reply without joining" prefix is now always one
  whitespace-free token that resolves back to the channel on the server the message came
  from (`@name` for a DM, else `#label`, `#name` without the server suffix, or the channel
  id), from the new `ChannelRegistry.proseTargetFor(channelId, serverId)`. It used to quote
  the label verbatim, and the prefix grammar reads the target as the first non-whitespace
  run: a DM labelled `DM: alice` gave `>>#DM: alice` (target `#DM:`, body `alice …`, so the
  reply bounced and the retained text went out with a stray `alice` line), and a suffixed
  label like `#fable (antra's server)` delivered `(antra's server)` as text. When no token is
  safe (the channel id is registered by more than one server, or every option contains
  whitespace) the invitation offers no prefix and points to joining the channel instead.

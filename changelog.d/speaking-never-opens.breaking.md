- **Residents and hosts:** speaking never opens a channel. A send tool's call (`send_message`,
  `reply_message`, `send_dm`, `send_file`, `send_files`) or plain speech into a registered channel
  that is closed publishes there and leaves the channel closed, with its recorded decision
  unchanged. Before, it opened the channel, recorded that open over the agent's own
  `channel_close`, and announced "[channels] Now open: … your own message into the closed channel
  engaged it".
  - **Who needs to act:** an agent that wants a channel's ongoing traffic after speaking there
    opens it with `channel_open`. Apart from subscription policy and server bootstrap, that is
    now the only way a closed channel opens. Messages that address the agent still arrive while
    a channel is closed.
  - **Unchanged:** typing indicators and reactions, which never depended on a channel being
    open. Channels that earlier sends opened stay open; once the agent closes one, it stays
    closed. Subscription-policy admission and its notice, whose last sentence now says that a
    closed channel stays closed until the agent opens it, and that speaking there never reopens
    it. `channel_close`'s description says the same.
  - Speech into a closed channel on a server whose grant lacks `channels.lifecycle` now
    publishes; before, the open threw and the speech failed. A send no longer re-runs the open
    of a channel decided open whose transport is down: reconciliation and `channel_open` do
    that, as they do for a channel nobody speaks in.
  - The closed-channel invitation is no longer added to a direct message (`chat:dm`): all of a
    DM reaches the agent whether it is open or not, and a DM the agent answers now stays closed,
    so the invitation would otherwise repeat on every DM. The tag describes the message, so a
    whisper tagged `chat:dm` inside a shared channel that is closed carries none either.
- **Direct `ChannelRegistry` consumers:** `openIfClosedForSend()` is removed.
  `resolveSendTarget(channelId, serverId?)` returns the descriptor id a send went to, from a
  composite or raw id, and opens nothing. `onChannelAutoOpened` reports only
  `source: 'subscription-policy'`, and its `conversationId` is gone. The
  `mcpl:channel-opened-by-send` and `mcpl:channel-open-failed` traces are no longer emitted.
- **Prompt cache:** `channel_close`'s description changes, so the first request after the
  upgrade that carries the channel tools misses the cache from its tool block on.

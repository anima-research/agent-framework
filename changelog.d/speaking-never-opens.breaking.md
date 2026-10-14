- **Residents and hosts:** speaking never opens a channel. A send tool's call (`send_message`,
  `reply_message`, `send_dm`, `send_file`, `send_files`) or plain speech into a registered channel
  that is closed publishes there and leaves the channel closed, with its recorded decision
  unchanged. Before, it opened the channel, recorded that open over the agent's own
  `channel_close`, and announced "[channels] Now open: … your own message into the closed channel
  engaged it".
  - **Who needs to act:** an agent that wants a channel's ongoing traffic after speaking there
    opens it with `channel_open`; speaking no longer does. Messages that address the agent still
    arrive while a channel is closed.
  - **What else changes:** the subscription-policy notice's last sentence and `channel_close`'s
    description now say that a channel the agent closes stays closed until it opens it with
    `channel_open`, and that neither speaking there nor policy reopens it. The closed-channel
    invitation is no longer added to a direct message (`chat:dm`), all of which reaches the
    agent whether the DM is open or not; a DM the agent answers now stays closed, so the
    invitation would otherwise repeat on every DM. A whisper tagged `chat:dm` inside a shared
    channel that is closed carries none either. Where no single-word target reaches a channel,
    the invitation no longer says that replying needs a join. A send no longer re-runs the open
    of a channel decided open whose transport is down: `channel_open` and the next registration's
    reconciliation do that, as they do for a channel nobody speaks in.
  - **Unchanged:** typing indicators and reactions, which never depended on a channel being
    open. A registered channel with a stored decision to open, including one that an earlier
    send opened, reconciles open at its next registration, as before. A DM known only from push
    events is never reconciled: one that an earlier send opened used to reopen on the agent's
    next reply after a restart, and now stays closed until the agent opens it.
- **Direct `ChannelRegistry` consumers:** `openIfClosedForSend()` is removed.
  `resolveSendTarget(channelId, serverId?)` returns the descriptor id of the channel a send went
  to, from a composite or raw id, and opens nothing. `onChannelAutoOpened` reports only
  `source: 'subscription-policy'`, and its `conversationId` is gone. The
  `mcpl:channel-opened-by-send` and `mcpl:channel-open-failed` traces are no longer emitted.
- **Prompt cache:** `channel_close`'s description changes, so the first request after the
  upgrade that carries the channel tools misses the cache from its tool block on.

- **Residents and hosts:** speaking never opens a channel. A send tool's call (`send_message`,
  `reply_message`, `send_dm`, `send_file`, `send_files`) or plain speech into a registered channel
  that is closed publishes there and leaves the channel closed, with its recorded decision
  unchanged. Before, it opened the channel, recorded that open over the agent's own
  `channel_close`, and announced "[channels] Now open: … your own message into the closed channel
  engaged it".
  - **Who needs to act:** an agent that wants a channel's ongoing traffic after speaking there
    opens it with `channel_open`; speaking no longer does. Messages that address the agent still
    arrive while a channel is closed.
  - **What residents notice:** on discord-mcpl, opening a channel also turns on its reaction
    forwarding, and closing it turns that off. A reply in a closed guild channel used to open
    it, and so turn its reactions on. Now reactions to the reply arrive only where the agent
    opens the channel or turns them on with `set_reaction_visibility`. DMs are unaffected:
    discord-mcpl requests no DM reaction events.
  - **What hosts notice:** on discord-mcpl, an answered channel's later messages that address
    the agent arrive as push events, as any closed channel's do, instead of `channels/incoming`.
    Host code that acts on `channels/incoming`, such as connectome-host's outage reply and typing
    hints, doesn't see them. Where a turn with no trigger (a heartbeat) speaks still follows the
    agent: a message pushed from a channel it answered while the channel was closed moves the
    most recent inbound channel, as an open channel's `channels/incoming` does. That holds across
    a restart, until the next decision about the channel (an open, a close, a decline or a
    tune-out). A decision made while the answer is still in flight, such as a close in the same
    round, stands too: the answer marks nothing. For a DM, every message of which reaches the
    agent, that is as before. An answered guild channel's messages that don't address the agent no
    longer arrive, so only those that do move it. A push from a closed channel the agent never
    answered moves nothing, as before.
  - **What else changes:** the subscription-policy notice's last sentence and `channel_close`'s
    description now say that a channel the agent closes stays closed until it opens it with
    `channel_open`, and that neither speaking there nor policy reopens it. The closed-channel
    invitation is no longer added to a direct message (`chat:dm`), all of which reaches the
    agent whether the DM is open or not; a DM the agent answers now stays closed, so the
    invitation would otherwise repeat on every DM. A whisper tagged `chat:dm` inside a shared
    channel that is closed carries none either. Where no single-word target reaches a channel,
    the invitation no longer says that replying needs a join: it suggests checking whether the
    server has a send tool that can address the channel, and says that follow-ups reach the
    agent only when they address it. A send no longer re-runs the open of a channel decided open
    whose transport is down: `channel_open` does that, and so does the next registration's
    reconciliation for a channel its server registers, as for a channel nobody speaks in.
  - **Unchanged:** typing indicators, which never depended on a channel being open. A registered
    channel with a stored decision to open, including one that an earlier send opened,
    reconciles open at its next registration, as before. A DM known only from push events is
    never reconciled: one that an earlier send opened used to reopen on the agent's next reply
    after a restart, and now stays closed until the agent opens it.
- **Direct `ChannelRegistry` consumers:** `openIfClosedForSend()` is removed.
  `resolveSendTarget(channelId, serverId?)` returns the descriptor id of the channel a send went
  to, from a composite or raw id, and opens nothing. `decisionSequence()`,
  `noteAnswered(channelId, serverId, decidedSince)` and
  `notePushDelivered(serverId, channelId, messageId?, threadId?, tags?)` are new: `routeSpeech`
  and the framework's send path read the first before they publish and call the second when the
  agent answers a closed channel, and the framework's push lane calls the third when it accepts
  a push. A module's `channel_close` with an unknown machine source is now refused even when the
  channel is already closed. The coalescer's host can observe each occurrence it admits afresh
  (`accepted`).
  `onChannelAutoOpened` reports only `source: 'subscription-policy'`, and its `conversationId` is
  gone. The `mcpl:channel-opened-by-send` and `mcpl:channel-open-failed` traces are no longer
  emitted. A `desired-state` record in the channel lifecycle log can carry `answered: true`;
  earlier versions ignore the field.
- **Prompt cache:** `channel_close`'s description changes, so the first request after the
  upgrade that carries the channel tools misses the cache from its tool block on.

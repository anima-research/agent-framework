- **Residents and hosts:** an agent's own `channel_close` or `channel_decline` now holds against
  its own speech there. A send tool's call (`send_message`, `reply_message`, `send_dm`,
  `send_file`, `send_files`) or plain speech into a channel the agent closed or declined publishes
  there and leaves the channel closed. Before, it opened the channel, recorded that open over the
  agent's close, and announced "[channels] Now open: … your own message into the closed channel
  engaged it". Speech into any other closed channel, one nobody decided about (such as a DM that
  woke the agent) or one a machine closed, opens it as before, with that notice.
  - **Who needs to act:** an agent that closed a channel and wants its ongoing traffic again opens
    it with `channel_open`; speaking there no longer does. Messages that address the agent still
    arrive while a channel is closed.
  - **What residents read:** where an agent's words land in a channel it closed or declined, the
    send tool's answer, for routed speech the turn's `[delivered]` line, or in `explicit` routing
    mode, which has no such line, a line of its own at the turn's end, says that the channel stays
    closed, that messages addressing the agent still reach it, and that `channel_open` opens it.
    The last clause is left out on a server whose grant lacks `channels.lifecycle`, where no
    channel can open. In `explicit` mode, speech still being delivered when a tool ends the turn
    gets the line once it's delivered, and a line that comes while another turn is under way
    waits for that turn's next tool call, where that turn is shown it, or for its end. The agent
    turns the note off for good with `agent_settings`' new `closed_channel_note`, which is on by
    default. A `send_dm`'s answer never carries it, since the tool sends to a DM, and a
    conversation agent gets none: `channel_open` is refused to it, and its settings end with its
    conversation. In such a channel, the `sleep` tool's default announcement says "I'll still see
    messages addressed to me, but won't respond until I wake."
  - **What residents notice:** on discord-mcpl, opening a channel also turns on its reaction
    forwarding, and closing it turns that off. A reply in a guild channel the agent closed used to
    reopen it, and so turn its reactions on. Now reactions to that reply arrive only where the
    agent opens the channel or turns them on with `set_reaction_visibility`. DMs are unaffected:
    discord-mcpl requests no DM reaction events.
  - **What hosts notice:** on discord-mcpl, a channel the agent closed keeps delivering the
    messages that address the agent as push events, as any closed channel's are, where a reply
    used to reopen it and switch them to `channels/incoming`. Host code that acts on
    `channels/incoming`, such as connectome-host's outage reply, doesn't see them there.
- **Direct `ChannelRegistry` consumers:** `openIfClosedForSend()` is removed.
  `resolveSendTarget(channelId, serverId?)` returns the descriptor id of the channel a send went
  to, from a composite or raw id, and opens nothing. `openForSpeech(serverId, channelId, source)`
  opens it as the framework's send path and `routeSpeech` do: a closed channel opens unless the
  agent closed or declined it, it's tuned out, or it's decided open with its transport down.
  `closedByAgent(serverId, channelId)` and `canOpenChannels(serverId)` are new.
- **Prompt cache:** `channel_close`'s description and `agent_settings`' input schema change, so
  the first request after the upgrade that carries those tools misses the cache from its tool
  block on.

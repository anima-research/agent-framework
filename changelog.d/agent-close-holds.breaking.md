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
    default. A conversation agent gets none: `channel_open` is refused to it, and its settings end
    with its conversation. In such a channel, the `sleep` tool's default announcement says "I'll
    still see messages addressed to me, but won't respond until I wake." A send tool's call into a
    channel the agent tuned out, which ended the tune-out before, now leaves it in place, and its
    answer says so: "… stays tuned out: your words there don't end the tune-out, so its traffic
    still goes to your subconscious until the tune-out ends. tune_out with channelId … and mode
    "cancel" resumes normal attention there." The same setting turns that line off.
  - **What the invitation says:** the closed-channel invitation's first option now says what
    replying does there. In a channel the agent closed or declined itself, it reads as before:
    "Reply without joining …", with the note that follow-ups that don't address the agent won't
    reach it. In any other closed channel, where a reply opens the channel, it reads "1. Reply —
    … it will be delivered there, and replying joins the channel, as option 2 does. To reply
    without joining, decline it first (option 3): a channel you've declined stays closed when you
    speak there." Before, it offered "Reply without joining" there too, though the reply opened
    the channel.
  - **What residents notice:** on discord-mcpl, opening a channel also turns on its reaction
    forwarding, and closing it turns that off. A reply in a guild channel the agent closed used to
    reopen it, and so turn its reactions on. Now reactions to that reply arrive only where the
    agent opens the channel or turns them on with `set_reaction_visibility`. DMs are unaffected:
    discord-mcpl requests no DM reaction events. discord-mcpl's `channels/open` also lifts a mute
    set with `mute_channel`, so a reply that opens a muted channel nobody decided about, or one a
    machine closed, unmutes it, as before; a channel the agent closed keeps its mute. On zulip_mcp, an answer's topic comes from the
    last message delivered as `channels/incoming`, and a closed stream's mentions are pushed
    instead, so in a stream the agent closed, every answer goes to the topic of the stream's last
    message from before the close, where a reply used to reopen the stream.
  - **What hosts notice:** on discord-mcpl, a channel the agent closed keeps delivering the
    messages that address the agent as push events, as any closed channel's are, where a reply
    used to reopen it and switch them to `channels/incoming`. Host code that acts on
    `channels/incoming`, such as connectome-host's outage reply, doesn't see them there. Nor does
    a turn with no trigger, such as a heartbeat, come to speak there: where it speaks moves only
    with `channels/incoming` messages.
- **Hosts with modules that close channels:** a module's `channel_close` through its own tool
  call (`ctx.callTool`) without a machine source is now recorded with the source `module-tool`,
  where it was `agent-tool`. Speech leaves such a channel closed, as it does one the agent closed,
  but gives no note, since the module owns the way back. In connectome-host that's the `mentions`
  channel mode: a reply to a mention in a channel in that mode stays a reply, and the invitation
  there offers "Reply without joining". Policy doesn't lift such a close, a machine's close
  doesn't replace it, and the agent's own close does. A module's close is never refused as a
  machine's close of an explicit open; only one naming a machine source is.
- **Direct `ChannelRegistry` consumers:** `openIfClosedForSend()` is removed.
  `resolveSendTarget(channelId, serverId?)` returns the descriptor id of the channel a send went
  to, from a composite or raw id, and opens nothing. `speechOpens(serverId, channelId)` says whether
  the agent's words there open the channel: a closed channel opens unless the agent closed or
  declined it, a module closed it, it's tuned out, or its server's grant lacks
  `channels.lifecycle`.
  `openForSpeech(serverId, channelId, source)` opens it where `speechOpens` says so, as the
  framework's send path and `routeSpeech` do. `closedByAgent(serverId, channelId)` and
  `canOpenChannels(serverId)` are new.
- **Prompt cache:** `channel_close`'s description and `agent_settings`' input schema change, so
  the first request after the upgrade that carries those tools misses the cache from its tool
  block on.

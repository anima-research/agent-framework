- **Residents and hosts:** an agent's own `channel_close` or `channel_decline` now holds against
  its own speech there. A send tool's call (`send_message`, `reply_message`, `send_dm`,
  `send_file`, `send_files`), plain speech, or a draft's resend into a channel the agent closed or
  declined publishes there and leaves the channel closed. Before, it opened the channel, recorded
  that open over the agent's close, and announced "[channels] Now open: … your own message into the
  closed channel opened it." That holds where the agent's close failed at the server and left the
  channel's transport open too: the words go out there, and the close stays the decision on record,
  where speech used to reopen the channel. Words that wait on a channel's lifecycle work, or on an
  open they started, go into the channel as it stands once the agent closes or declines it
  meanwhile, or a module closes it, where they were refused with "a decision to close the channel
  came before these words went out". They're still refused where the channel's address kept
  changing until the tries ran out, and a channel whose last open the server answered for another
  channel takes no words as it stands until an open of it is answered for this channel, since a
  publish by its id may not reach it. Speech into any other closed channel, one nobody decided
  about (such as a DM that woke the agent) or one a machine closed, opens it as before, with that
  notice, and a close a machine decides while words wait still refuses them.
  - **Who needs to act:** an agent that closed a channel and wants its ongoing traffic again opens
    it with `channel_open`; speaking there no longer does. Messages that address the agent still
    arrive while a channel is closed.
  - **What residents read:** where an agent's words land in a channel it closed or declined, the
    send tool's answer, for routed speech the turn's `[delivered]` line, or in `explicit` routing
    mode, which has no such line, a line of its own at the turn's end, says that the channel stays
    closed, and, as each holds for the agent reading it, that messages addressing it still reach
    it, that `channel_open` opens it, and how to turn the note off. The first is left out for an
    agent whose window isn't where those messages land, such as an ephemeral run's; `channel_open`
    where the agent's `allowedTools` leave it out, or on a server that's up but whose grant lacks
    `channels.lifecycle`, where no channel can open; and the last where `allowedTools` leave
    `agent_settings` out. In `explicit` mode, speech still being delivered when a tool ends the
    turn gets the line once it's delivered, and a line that comes while another turn is under way
    waits for that turn's next tool call, where that turn is shown it, or for its end. The agent
    turns the note off for good with `agent_settings`' new `closed_channel_note`, which is on by
    default. A conversation agent gets none: `channel_open` is refused to it, and its settings end
    with its conversation. In a channel the agent's words leave closed, one it closed or declined,
    one a module closed, or a closed one on a server that's up without `channels.lifecycle`, the
    `sleep` tool's default announcement says "I'll still see messages addressed to me, but won't
    respond until I wake." A send tool's call into a channel the agent tuned out keeps the
    tune-out, as it has since 0.23.0, and its answer now says so: "… stays tuned out: your words
    there don't end the tune-out, so its traffic still goes to your subconscious until the tune-out
    ends. Call tune_out with channelId … and mode "cancel" for it to resume normal attention;
    cancelling delivers the diverted backlog." The last sentence is `tune_out`'s own refusals' one,
    naming the channel as they do, for an agent whose `allowedTools` hold `tune_out`. The same
    setting turns that line off. A send a `code_execution` script makes keeps the server's receipt
    alone, since the script parses it, and the agent gets the note or the tune-out line in its
    window instead, as a notice.
  - **What the invitation says:** the closed-channel invitation's first option now says what
    replying does there. In a channel the agent closed or declined itself, or a module closed, a
    reply no longer opens the channel, and the option says so: "1. Reply — … it will be delivered
    there, and the channel stays closed." Before, it said "… which opens the channel" there too. It
    says the same on a server whose grant lacks `channels.lifecycle`, where nothing opens. In any
    other closed channel, where a reply still opens the channel, it adds how to reply without
    opening it: "To reply without opening it, decline it first (option 3): a channel you've
    declined stays closed when you speak there." It leaves that out in a tuned-out channel, which
    `channel_decline` refuses. What else reaches the agent from a channel left closed is its
    server's to say (#406): on discord-mcpl, the channel's later messages that don't address the
    agent don't arrive as they're posted, and anima-research/discord-mcpl#97 has discord-mcpl say
    so on its push.
  - **What residents notice,** by our reading of discord-mcpl's and zulip_mcp's code: on
    discord-mcpl, opening a channel also turns on its reaction forwarding, and closing it turns
    that off. A reply in a guild channel the agent closed used to reopen it, and so turn its
    reactions on. Now reactions to that reply arrive only where the agent opens the channel or
    turns them on with `set_reaction_visibility`. DMs are unaffected: discord-mcpl requests no DM
    reaction events. discord-mcpl's `channels/open` also lifts a mute set with `mute_channel`, so a
    reply that opens a muted channel nobody decided about, or one a machine closed, unmutes it, as
    before; a channel the agent closed keeps its mute. On zulip_mcp, an answer's topic comes from
    the last message delivered as `channels/incoming`, and a closed stream's mentions are pushed
    instead, so in a stream the agent closed, every answer goes to the topic of the stream's last
    message from before the close, where a reply used to reopen the stream.
  - **What hosts notice,** by our reading of discord-mcpl's and connectome-host's code: on
    discord-mcpl, a channel the agent closed keeps delivering the messages that address the agent
    as push events, as any closed channel's are, where a reply used to reopen it and switch them to
    `channels/incoming`. Host code that acts on `channels/incoming`, such as connectome-host's
    outage reply, doesn't see them there. Nor does a turn with no trigger, such as a heartbeat,
    come to speak there: where it speaks moves only with `channels/incoming` messages.
- **Hosts with modules that close channels:** a module's `channel_close` through its own tool call
  (`ctx.callTool`) without a machine source is now recorded with the source `module-tool`, where it
  was `agent-tool`. Speech leaves such a channel closed, as it does one the agent closed, but gives
  no note, since the module owns the way back. In connectome-host that's the `mentions` channel
  mode: a reply to a mention in a channel in that mode stays a reply, and the invitation there says
  the channel stays closed. Policy doesn't lift such a close, and a machine's close doesn't replace
  it. Of the agent's close and a module's, the later one is the one on record. A module's close is
  never refused as a machine's close of an explicit open; only one naming a machine source is.
  - **Who needs to act:** a module's close made before this change was recorded as `agent-tool`,
    which can't be told apart from the agent's own, so after the upgrade such a channel reads as
    one the agent closed, and the agent's words there carry the note. Setting the channel's mode
    again (connectome-host's `channel_mode` with `mentions`) records the close as the module's.
- **Direct `ChannelRegistry` consumers:** `openIfClosedForSend()` answers a new `status`,
  `stays-closed`, for a channel a send leaves closed without trying to open it: one the agent
  closed or declined, one a module closed, or a closed one on a server that's up but whose grant
  lacks `channels.lifecycle`, where it answered `open-failed` or opened the channel. For an open
  channel on such a server that isn't decided open, it answers `already-open` without trying an
  open, where it answered `open-failed`. `speechOpens(channel)` says whether the agent's words
  there open the channel, and `speechLeavesClosed(channel)` whether they go into it and leave it
  closed. `closedByAgent(channel)`, `lifecycleWithheld(serverId)`, `tuneOutEnd(channel)` and
  `resolveSendTarget(channelId, serverId?)`, which names the one channel a send went to from a
  composite or raw id, and opens nothing, are new too.
- **Prompt cache:** `channel_close`'s description and `agent_settings`' input schema change, so the
  first request after the upgrade that carries those tools misses the cache from its tool block on.

- **Hosts:** `speech.locus` defaults to `'delivery'`, and a `channel_publish`
  with no `channelId` goes where the calling turn's plain speech would. A
  host that relied on its agents' prose or publishes reaching the channel
  of the latest message needs to act.
  - **Before, plain prose** (under prose routing by locus, `'locus'` or
    `'hybrid'`): a turn no channel message woke fell back to the channel
    of the most recent inbound message (a reaction, an edit, a deletion or
    a system notice aside), unless it was a conversation fork's, a
    heartbeat's, a `noChannel` turn or an ephemeral agent's, as now. An
    addressed message injected mid-turn from another channel moved the
    turn's speech to that channel, and so did one that arrived between the
    turn's streams, at its next start.
  - **Before, `channel_publish` with no `channelId`:** it went to the
    channel of the most recent inbound message (the same markers aside),
    whichever turn called it or whether or not one did. A conversation
    fork's own call went to its home, as now, but one a host made for it
    through `executeToolCall` took the latest message's channel, and now
    takes the home. It was refused when there was none or the caller was
    an ephemeral agent.
  - **Now, plain prose** (under prose routing by locus): only the delivery
    that woke a turn, a conversation fork's home channel or a channel the
    agent opened during the turn sets its locus. A turn with no locus falls
    back only to an open all-except tune-out's excepted channel, and
    otherwise keeps its prose private; a heartbeat's turn, a `noChannel`
    turn and an ephemeral agent's take no fallback. An addressed message
    from another channel moves nothing, and the agent is told, once per
    channel per turn, in a `[routing]` notice.
  - **Now, `channel_publish` with no `channelId`:** from a turn, it goes to
    the turn's locus, else a conversation fork's home channel, else the
    channel of the message that woke the turn, else the fallback. Made
    outside any turn, as a script left running after its turn makes, it
    goes to a conversation fork's home channel, else the fallback. The
    fallback is only an open all-except tune-out's excepted channel, and a
    heartbeat's turn, a `noChannel` turn and an ephemeral agent don't take
    it. The call is refused when none of these names a channel.
  - **Migration:** `speech: { locus: 'latest-inbound' }` brings back the
    re-pins on an addressed injection and on an arrival, and makes the most
    recent delivered inbound message's channel the fallback again, after
    an open all-except tune-out's, for prose and for a publish. No setting
    sends a publish from a turn there ahead of the turn's own channel, or
    from a turn that takes no fallback: a publish meant for it names its
    `channelId`.
  - **Unchanged:** a `channel_publish` that names its `channelId` goes to
    that channel.

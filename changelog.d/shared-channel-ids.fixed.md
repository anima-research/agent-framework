- Two MCPL servers can register the same channel id (MCPL requires one to be
  unique only within a server's connection), and the framework now tells
  their channels apart wherever it acts on one, instead of taking whichever
  server registered the id first, or refusing the id outright.
  - A turn's plain speech, its typing indicator and its outgoing stream go to
    the channel on the server the turn's message came from. Speech to a
    shared id was refused as ambiguous, with a failure marker, and typing
    showed on the server that registered the id first. The `[routing]` and
    `[channels]` notices, the turn's receipt, a bounce, the drafts'
    destinations and the channel tools' results and refusals name such a
    channel by its server-qualified id, `serverId:channelId`.
  - `channel_publish` and the subconscious's `speak_in_channel` refuse a
    shared id, naming each candidate by its server-qualified id, and take
    that form in `channelId` to name one server's channel. Both posted on the
    server that registered the id first. `tune_out` does the same, where it
    tuned out the channel on the server that registered the id first, and its
    result names the channel as the agent can name it back.
    `channel_open`, `channel_close` and `channel_decline` take the form too,
    alone, and a `serverId` beside a `channelId` names that server's channel
    with that exact id. The refusal names each candidate so it can be told
    apart, without "not found". Ids hold colons, so two channels'
    server-qualified ids can be one string, as `a`'s `b:room` and `a:b`'s
    `room` are: such a name is refused as a shared id is, and a channel no
    string picks alone is named by its id and server, `"b:room" on server
    "a"`. No tool's description or schema changes.
  - The subconscious's `cancel_tuneout` reads a name as `tune_out` does: it
    refuses a name two registered channels answer to, naming both, and takes
    the server-qualified form, where it cancelled the one on the server that
    registered the id first. Its `deliver_summary` refuses such a name too,
    and tags the summary with the channel's server, where it stored the id
    alone. Tune-out's notices, and the reasons its wakes
    give, name such a channel by its server-qualified id, and `tune_out`
    refuses a channel because a conversation is bound to it only when that
    conversation is bound to that server's channel.
  - A `>>` or `>>>` target takes the server-qualified id, and a shared id or
    label is refused with its candidates named so each can be told apart.
    `>>b:general` matched nothing, and a shared label's candidates read as
    the same id twice. `prose_help`'s reference shows the form. A `<@id>`
    mention or an `@name` that one person's DMs on two servers answer to is
    refused with both named apart, where a mention was refused as matching
    no DM. A closed-channel invitation for a channel whose id another server
    shares offers a `>>` reply naming its server.
  - A host's bare id to `startTyping` or `stopTyping` types in each server's
    channel with that id, so connectome-host's activity indicator shows in
    both, rather than on the first registered server. Where two servers reach
    one platform channel, two bots can show typing there.
  - `publishForAgent` refuses a shared bare id, where it posted on the first
    registered server. A host that passes the server as a ref is answered
    there, as one that passes `serverId:channelId` is where that names one
    channel alone.
  - A push's channel is registered for the server that pushed it, whatever
    another server registers, and its reply goes back through that server.
    A push leaves the entry of another server's channel with that id as it
    was.
  - Within a turn, a `>>` or `>>>` target, a drafts resend's destination,
    and the `channelId` of `channel_publish`, `channel_open`,
    `channel_close`, `channel_decline`, `tune_out` and the subconscious's
    `cancel_tuneout`, `speak_in_channel` and `deliver_summary`, that name
    the id of a channel the turn has been in (the channel of the message it
    answers, and any a mid-turn message or `channel_open` moved it to) mean
    that channel on its server, and, where two of the turn's channels on
    two servers have that id, neither, with each named. Where another
    server registers the same id, such a reply
    goes back where the message came from, where it was refused as a shared
    id; once that channel's server no longer registers it, the call is
    refused, where it went out through, or acted on, another server's
    channel with the id. A tool call takes the turn's channels only
    when it is made inside the turn, and a script's call only when the turn
    that started the script is the one waiting on it, so a script left
    running after its turn takes none, and a later turn's channels aren't
    lent to it.
  - `channel_publish` with no `channelId` posts to its default channel, the
    latest message's, on the server that message came from, and is refused
    once that server no longer registers the channel, where it went out
    through another server that registers the id. The refusal names no other
    channel to post to, since the one with that id that remains is another
    server's.
  - A wake that names its channel without the server, such as a host's
    inference request, by an id two servers share or that no registered
    channel has, gives the turn no channel and no fallback. Its speech isn't
    published, as before, and the agent is no longer told its speech lands in
    the first registered server's channel.
  - The deprecated conversation routing gives each server's channel its own
    fork, where a second server's channel with the same id reached the first
    one's fork. A fork's `channel_publish` and `channel_close` of its home's
    id act on its home, on its server, where they acted on the first
    registered server's channel, and a home its server no longer registers is
    refused as such. An addressed wake's route applies to the fork homed on
    that server's channel only.
  - Coalesced work for a channel is admitted only while its own server
    registers the channel, not another server's channel with the same id.
  - A batched gate wake's summary lists two servers' channels with one id
    apart, each with its count, where it merged them into one line under
    the first one's label.
  - Two servers' wakes on one channel id at one moment are two wakes to a
    provider hold, where one was dropped as the other's duplicate.
  - The registry keeps each channel under its server and id together, so
    server `a`'s channel `b:room` and server `a:b`'s channel `room`, which a
    key joined with a colon gave one entry, are two.

- `channel_close` of the channel an all-except hold excepts says what holds of the focus when its answer
  arrives. A close whose hold's release waited for held writes, and ran while the close's transport
  round-trip was awaited, answered `status: 'closed'` with "The close cancels the all-except hold that
  excepts it. Not cancelled yet: …" though the focus had ended. The answer's sentence is now read as the
  answer is built: "The focus on it ended, and what the other channels held was delivered." where the hold
  has ended by then, and the wait's note where it is still in force.
- A `channel_close` of the excepted channel whose hold's release failed after it had ended the focus (a step
  after the end, such as the resident's wake, threw) answered "The close wasn't recorded: <reason>" and said
  nothing of the focus. It now answers "The close wasn't recorded: <reason>. The focus on it ended before
  that failure, and what the other channels held was delivered." A release that fails before the end
  answers "The close wasn't recorded: <reason>. The focus on it is still in force: what the other channels
  hold stays held until it ends. A resident ends it with tune_out { mode: 'cancel', scope: 'all-except' },
  or asks this close again." — the answer says the hold stays, not only the reason. The release's
  failure is now the close's answer, as the registry's other failures are, where `executeToolCall` rejected
  with it before.
- A `channel_close` naming the channel an all-except hold excepts, after its server stopped registering it
  (removed by `channels/changed`, or the server removed), answered "No channel has the id "work", so nothing
  ran. channel_list shows the channel ids." and left the focus in force. An agent's close given that
  channel's id, its server-qualified name, its id with its `serverId`, or, inside the turn whose channel it
  was, its id, now ends the focus as a close of the registered channel ends it, its backlog released, and
  answers, as a failure since no close ran: "Server "editor" no longer registers channel "work", so no close
  was recorded or sent. The focus on it ended, and what the other channels held was delivered." The release
  notice gives its reason as "a close of the excepted channel, which its server no longer registers". While
  the store's writes are held the answer says "This call cancels the all-except hold that excepts it." and
  the wait's note; a release that fails before the end adds "The focus on it wasn't ended: <reason>. The focus on it is
  still in force: …" (the same sentence as above), and
  one that fails after it "A step of the focus's release failed: <reason>. The focus on it ended before
  that failure, and what the other channels held was delivered." A module's close of such a name is
  refused as before, the focus left in force.
- A `channel_close` answer built after its focus ended names a replacement all-except focus in force by
  then: "… A new all-except focus is in force now, excepting <server>/<channel>: not this close's, and what
  the other channels hold stays held until it ends." — so an agent whose close waited on held writes or a
  transport round-trip is told the focus it accounts for next, not only that its own ended.
- An agent's `channel_close` given a bare id (no `serverId`) that the channel an all-except hold excepts answers
  to now acts on that channel, not on another server's channel with the same id. After the hold's channel
  (`editor`'s `work`) stopped being registered and another server registered `work`, a repeat
  `channel_close({ channelId: "work" })` outside a turn of that channel closed `other`'s `work`, answered
  `{ channelId: "work", serverId: "other", status: "closed" }`, and left the focus in force. It now ends the
  focus as the vanished-channel close above does, sends `other` no close, and adds "Channel "work" on server
  "other" was not closed: to close it, call again with channelId "work" and serverId "other"." (the channel's own
  id, which a focus on `other:work` beside `other`'s `work` doesn't share). With the hold's channel still registered beside
  another server's `work`, the bare id, refused before as on more than one server, now closes the hold's
  channel and adds the same sentence to the answer's `note`. A close that names `other` (`serverId: "other"`
  or `"other:work"`) closes `other`'s `work` and leaves the focus alone. A name the calling turn's own channel
  answers to, a module's close, and any close while no focus is in force resolve as before.

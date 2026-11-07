- A `channel_close` of the channel an all-except hold excepts answers, once its focus has ended, "The focus on it
  ended, and what the other channels held was delivered, up to its backlog cap." (0.32.0: "The focus on it ended
  all the same, and what the other channels held was delivered."). Where the focus's release fails, it answers
  the failure with what holds of the focus: "The close wasn't recorded: <reason>. The focus on it ended before
  that failure, and what the other channels held was delivered, up to its backlog cap." where a step after the
  end (such as the resident's wake) threw; otherwise "The close wasn't recorded: <reason>. The focus on it is
  still in force: what the other channels hold stays held until it ends.", or, where the release couldn't be
  made durable after its notice was stored, "… The focus on it is still in force, but its release notice, with
  what the other channels held up to its backlog cap, was stored before that failure: what they hold from now on
  stays held until it ends.", each followed by "A resident ends it with tune_out { mode: 'cancel', scope:
  'all-except' }, or asks this close again." In 0.32.0 such a failure rejected `executeToolCall` with "The close
  wasn't recorded: <reason>" and said nothing of the focus; it is now the close's answer, as the registry's other
  failures are.
- An agent's close of the excepted channel after its server stopped registering it (removed by
  `channels/changed`, or the server removed), by the channel's id, its server-qualified name, its id with its
  `serverId`, or, inside the turn whose channel it was, its id, now ends the focus as a close of the registered
  channel does, its backlog released, the release's reason "a close of the excepted channel, which its server no
  longer registers". It answers as a failure, since no close ran: "Server "editor" no longer registers channel
  "work", so no close was recorded or sent." and what holds of the focus as above ("A step of the focus's release
  failed: <reason>." or "The focus on it wasn't ended: <reason>." where the release fails). In 0.32.0 it was
  refused ("No channel has the id "work", so nothing ran. …", or a like refusal for another form of its name), the
  focus left in force. A module's close of such a name is refused as before.
- A `channel_close` answer built after its focus ended names an all-except focus in force by then in its place:
  "… A new all-except focus is in force now, excepting <server>/<channel>: not this close's, and what the other
  channels hold stays held until it ends."
- An agent's bare `channel_close({ channelId: "work" })` that the excepted channel answers to now acts on that
  channel, not on another server's `work`. Where the focus's channel (`editor`'s `work`) is no longer registered
  and `other` registers a `work`, it ends the focus as above and closes nothing on `other`, where 0.32.0 closed
  `other`'s `work` outside a turn of the focus's channel and left the focus in force; where both are registered,
  it closes the focus's channel, where it was refused as on more than one server. Either answer adds "Channel
  "work" on server "other" was not closed: to close it, call again with channelId "work" and serverId "other"." A
  close naming `other` (`serverId: "other"` or `"other:work"`) closes `other`'s `work` and leaves the focus alone,
  and a name the calling turn's own channel answers to (unless the focus's channel answers to it too, which is
  refused), a module's close and any close while no focus is in force resolve as before.

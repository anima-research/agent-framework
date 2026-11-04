- `channel_close` of the channel an all-except hold excepts says what holds of the focus when its answer
  arrives. A close whose hold's release waited for held writes, and ran while the close's transport
  round-trip was awaited, answered `status: 'closed'` with "The close cancels the all-except hold that
  excepts it. Not cancelled yet: …" though the focus had ended. The answer's sentence is now read as the
  answer is built: "The focus on it ended, and what the other channels held was delivered." where the hold
  has ended by then, and the wait's note where it is still in force.
- A `channel_close` of the excepted channel whose hold's release failed after it had ended the focus (a step
  after the end, such as the resident's wake, threw) answered "The close wasn't recorded: <reason>" and said
  nothing of the focus. It now answers "The close wasn't recorded: <reason>. The focus on it ended before
  that failure, and what the other channels held was delivered." A release that fails before the end still
  answers "The close wasn't recorded: <reason>", the reason saying the hold stays in force. The release's
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
  the wait's note; a release that fails before the end adds "The focus on it wasn't ended: <reason>", and
  one that fails after it "A step of the focus's release failed: <reason>. The focus on it ended before
  that failure, and what the other channels held was delivered." A module's close of such a name is
  refused as before, the focus left in force.

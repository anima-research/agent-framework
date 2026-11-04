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

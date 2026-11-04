- `channel_close` of the channel an all-except hold excepts says what holds of the focus when its answer
  arrives. A close whose hold's release waited for held writes, and ran while the close's transport
  round-trip was awaited, answered `status: 'closed'` with "The close cancels the all-except hold that
  excepts it. Not cancelled yet: …" though the focus had ended. The answer's sentence is now read as the
  answer is built: "The focus on it ended, and what the other channels held was delivered." where the hold
  has ended by then, and the wait's note where it is still in force.

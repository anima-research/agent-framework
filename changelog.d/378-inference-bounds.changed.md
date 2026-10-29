- A turn that ends on a timeout says so in its `[inference-failed]` note: the
  model call timed out, or its last call did, with the reason, which for a
  bound's cut names the bound that ran out. When that call was a fresh call made for an earlier cut and a
  deadline ended it too, the note says so: "The call was made again, and it timed out again." The cause in parentheses
  is left out when it's only `timeout`. Its closing line says that if a reply
  is still owed from that turn, it can be given now. Other failures keep their
  wording and advice.
- An MCPL server's streamed inference request that ends early is answered
  with the reason and, when membrane gives one, its message, such as the
  bound that ran out: ``The inference stopped before it finished (timeout:
  No content within 60s of the send: … (the host's setting for this bound:
  `inferenceBounds.progressBounds.beforeContentMs`))``.
- A stream cut's reason, in a turn's error and note and in an MCPL server's
  answer, ends by naming the host setting for the bound it hit, such as
  ``(the host's setting for this bound:
  `inferenceBounds.progressBounds.beforeContentMs`)``.

- A tune-out cancel asked for while a surgery's hold kept writes in memory is no longer lost when it fails at the
  release. It waited for the release and ran then, but the queue was emptied before it ran, so a run that threw (its
  backlog couldn't be made durable, or a store operation threw) was only logged: the tune-out stayed in force and the
  cancel, with a reader's note, was gone, and nothing tried it again. It now stays waiting with its note, the
  tune-out still in force, and runs again at the next release or 60 s later, whichever comes first; a stop clears
  the retry, the tune-out staying in force on disk as before.
- A tune-out cancel waiting for held writes now ends only the tune-out it was asked for. It was kept by channel
  alone, and its run cancelled whatever tune-out held the channel then: after its first release failed and that
  tune-out ended otherwise, a new tune-out on the same channel (or a new all-except hold) was ended by the old
  cancel's retry. It now records the epoch it was asked for. One whose epoch no longer holds is dropped at the
  release or the retry, ending nothing, and so is one a cancel of a later tune-out there finds waiting, which then
  waits in its place. Each drop is logged and traced as `tune-out:deferred-cancel-dropped`, with the epoch it was
  for and why. A run that recorded its tune-out's end and failed after it is logged and no longer queued again.

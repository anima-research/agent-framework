- A tune-out cancel asked for while a surgery's hold kept writes in memory is no longer lost when it fails at the
  release. It waited for the release and ran then, but the queue was emptied before it ran, so a run that threw (its
  backlog couldn't be made durable, or a store operation threw) was only logged: the tune-out stayed in force and the
  cancel, with a reader's note, was gone, and nothing tried it again. It now stays waiting with its note, the
  tune-out still in force, and runs again at the next release or 60 s later, whichever comes first; a stop clears
  the retry, the tune-out staying in force on disk as before.

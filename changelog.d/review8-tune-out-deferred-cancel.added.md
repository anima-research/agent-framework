- `tune-out:deferred-cancel-dropped` trace: a tune-out cancel that waited for held writes was taken off its queue
  with its work undone. It names the hold's channel (the excepted one for the all-except hold, with `scope`), the
  epoch the cancel was asked for (`epochId`), and why (`reason`): `hold-ended`, that hold ended without it
  (`currentEpochId`: the epoch in force then, if any); `note-undelivered`, the hold ended and the note it carried
  couldn't be delivered (`error`); `stopped`, the host stopped while it waited, and the next boot resumes the hold
  without running it; or `superseded`, it joined an earlier cancel of the hold that was running, whose note stands.
  `noteLost` says whether a reader's note it carried is lost with it, `noteAuthor` whose it was (the name it would
  be delivered under), and `noteMayBeStored`, with `error`, that storing the note threw where the store couldn't
  tell whether it landed, so its author is told it may be lost.
- `tune-out:note-loss-untold` trace: a notice telling a note's author of its loss wasn't written. It names the hold
  as above, `noteAuthor` and `reason`: `author-gone`, the author is no agent the framework writes to any more (a
  reader fork whose run has ended); or `write-failed`, with the `error`, traced at its first failure, after which
  the notice is tried again until it is written.

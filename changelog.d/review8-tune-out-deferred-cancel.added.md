- `tune-out:deferred-cancel-dropped` trace: a tune-out cancel asked for while writes were held in memory was taken
  off its queue with what it was for left undone. It names the hold's channel (the excepted one for the all-except
  hold, with `scope`), the epoch the cancel was asked for (`epochId`), and why (`reason`): `hold-ended`, that
  epoch's hold ended without it, so it ends nothing, with the epoch in force there then (`currentEpochId`, if one
  was); or `note-undelivered`, the hold ended, by another cancel or by the cancel's own run, and the note it carried
  could not be delivered (`error`). `noteLost` says whether a reader's note it carried is lost with it, and
  `noteAuthor` whose note it was: the name it would have been delivered under, the persistent subconscious's or the
  reader fork's.

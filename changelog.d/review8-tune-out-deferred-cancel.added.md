- `tune-out:deferred-cancel-dropped` trace: a tune-out cancel asked for while writes were held in memory was taken
  off its queue with what it was for left undone. It names the hold's channel (the excepted one for the all-except
  hold, with `scope`), the epoch the cancel was asked for (`epochId`), why (`reason`: `hold-ended`, that epoch's
  hold ended without it, so it ends nothing), the epoch in force there when it was dropped (`currentEpochId`, if
  one was), and whether a reader's note it carried is lost with it (`noteLost`).

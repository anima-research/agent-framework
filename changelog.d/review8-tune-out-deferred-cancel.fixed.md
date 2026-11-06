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
  for and why, and the author of a note the dropped cancel carried, where it still exists (not a reader fork whose
  run has ended), is told in its own context that the note was dropped with it. A run that recorded its tune-out's
  end and failed after it is logged and no longer queued again. A run delivers its note once its release is
  durable, and makes it durable before the end is recorded (the 844-queued-note-loss-in-release entry); a note it
  can't write is told lost to its author, and why, where it still exists, once the hold has ended, and the loss is
  traced (`note-undelivered`); a note that can't be written no longer stops the rest of that cancel.
- A reader's note queued with a tune-out cancel that waits for held writes now reaches the resident when another
  cancel ends that tune-out first, unless writing it then fails; its author is then told so, and why, unless it is a
  reader fork whose run has ended, which nothing can be written to. After the waiting cancel's first release failed,
  a resident's cancel, an end time or a close of the excepted channel could end the tune-out before the retry, and
  it delivered only its own caller's note: the queued one was never delivered. That cancel now takes the waiting one
  off the queue and delivers its note once, before the caller's own: a reader fork's after the release, as its mail,
  even after its run has ended, and the persistent subconscious's before the release, under its name (the
  844-queued-note-loss-in-release entry). If that write fails, the loss is logged and traced as
  `tune-out:deferred-cancel-dropped` (`note-undelivered`, with the reason and the author), and the note's author is
  told so: the persistent subconscious in the release itself, a reader fork in its own context, with the hold, the
  resident and the error's text, where it still exists. A reader fork whose run has ended is written nothing, and the
  loss, reaching no one, is traced as `tune-out:note-loss-untold` (`author-gone`); one still running whose context
  manager refuses its work has the notice kept for it, written once that ends; a fork whose own manager works is no
  longer kept waiting while the primary's or the subconscious's refuses its work, which holds the cancels only. The cancel still ends the tune-out. Each notice of a lost note gives
  the persistent subconscious a turn to read it. No notice is written while writes are held: it waits for their
  release. A notice of a lost note that can't be written was only logged; it is now kept, traced as
  `tune-out:note-loss-untold` (`write-failed`, with the author and the error) at its first failure, and tried again
  whenever held writes are stored and every 60 s while none are, until it is written. A notice for the persistent
  subconscious, whose context outlives the process, is also kept in the store (`tune-out/<primary>/loss-notices`), so
  it survives a stop: the next boot writes it into the subconscious's context, with the reason, and asks for its turn,
  and one that boot can't write stays kept and is tried again as before. Before, a stop dropped it, and that caller
  was left with neither its note nor a loss result. A reader fork's notice, whose run doesn't outlast a stop, is still
  dropped at a stop. A notice written after the drop says whether the later hold it names is still in force then.
- A reader's `cancel_tuneout` that waits for held writes, with a note, now says what becomes of the note: it is
  delivered when the hold ends; if it can't be, the reader is told so and why; if that notice can't be written
  either, the failure is traced and the notice is tried again until it is written. The persistent subconscious is
  told that such a notice is also kept in the store, unless the store refuses that too, so a stop before it is
  written leaves it for the next boot to write; and that the waiting cancel isn't kept in the store, so a stop before
  the hold ends loses it, and the note with it unless the cancel's run delivered the note already, a lost note told by such a notice kept for the next boot to write. A reader fork is told that its note goes out as its mail even after
  its run has ended, but that a loss reaches it only while it runs: after its end the loss reaches no one and is only
  traced, and a stop before the hold ends loses the note with the cancel, untold, unless it was delivered already. The answer said only that the
  cancel waits.

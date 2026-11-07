- At boot, an interrupted job's end is told from what its recipient's store holds: a result there counts as the
  job's own only when it was produced (`metadata.dendrite.producedAt`) at or after the job's record was created,
  so a result an earlier job of the same single-use name and incarnation delivered (a name whose counter aged out
  of the registry starts again at 1) doesn't stop the recipient from being told that the new job ended without a
  result. 0.32.0 looked for the result among the registry's held mail by the job's name alone, so an earlier
  job's result still held there stopped the recipient from being told, and a result already stored and released
  went unseen, the recipient told the job ended without one.

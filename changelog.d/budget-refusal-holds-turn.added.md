- **Hosts and operators:** an ops alert kind, `context-hold`, raised each
  time a turn goes into a budget hold (#304, under Fixed): a fresh hold, or a
  released turn whose start is refused again. Its clear, `context-hold-clear`,
  is raised at every end of that hold: a release, a hold that ends because
  compression had nothing left to do, and one ended with its turn, by a stop,
  an abandon, `abortInference()` or a disposal. So starts and clears pair one
  to one, and a request that joins a held turn raises neither. It's the
  framework's first alert kind with a clear.
  - **Its words:** the turn is held until compression makes room, the
    refused compile's reason, bounded so the whole stays within 2,000
    characters, and the way on that a surgery's refusal names, a quiesce with
    `abandon: true`. Its data carries the refusal's type and figures, and when
    the hold began; the clear's carries the hold's outcome and how long it
    lasted.
  - Neither is written to failures.log. The ops webhook's cooldown runs per
    kind, so a webhook can receive a clear whose start the cooldown held back;
    the `ops:alert` trace carries both every time.
  - A host that maps alert kinds to where it posts them needs an entry for
    `context-hold` to post it; one that treats an unlisted kind as silent
    posts nothing for it.

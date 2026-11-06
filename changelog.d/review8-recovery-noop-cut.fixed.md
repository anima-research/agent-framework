- Offline recovery on a presented window refuses a recovery that would change nothing, as the live rollback does.
  When the anchor was presented in one write with the rows after it (a `--messages` count landing inside such a
  batch, or an anchor named in one), the cut at that write keeps every one of them, and the recovery made a branch
  that removed nothing and reported success. It now fails before anything is prepared (a dry run too), names the
  first of the rows that write presented after the anchor, and points to suppressing them: a row with a Discord
  message id in the same recovery (`--suppress` / `suppressMessageIds`, or `--suppress-range`), one without by its
  row id with the live `suppressMessages`, each of those named by its id; an anchor already at the window's tail is
  refused as such. A cut that removes nothing but makes a row an arrival again still goes ahead. The recovery reads
  the agent's own slot alone, so a row of a slot it observes (the residents' rows in a persistent subconscious's
  window), which the live rollback weighs, is neither counted in `returnedToArrivals` nor seen by this check; the
  refusal says so.

- Offline recovery on a presented window refuses a recovery that would change nothing, as the live rollback does.
  When the anchor was presented in one write with the rows after it (a `--messages` count landing inside such a
  batch, or an anchor named in one), the cut at that write keeps every one of them, so the recovery fails before
  anything is prepared (a dry run too), names the
  first of the rows that write presented after the anchor, and points to suppressing them: a row with a Discord
  message id in the same recovery (`--suppress` / `suppressMessageIds`, each Discord id named), one without, or one
  sharing the anchor's Discord id (a retried write's copy, which the offline suppression would take with the
  anchor), by its row id with the live `suppressMessages`, each of those named by its id. No `--suppress-range` is
  offered: a range takes every row stored between its ends, any agent's, rows the window never held among them. A
  row holding a result of a call at or before the anchor isn't advised for suppression, which would leave the call
  without its result (the recovery itself refuses that split): the refusal says to anchor before the call. An
  anchor already at the window's tail is refused as such. A cut that removes nothing but makes a row an arrival again still goes ahead. The recovery reads
  the agent's own slot alone, so a row of a slot it observes (the residents' rows in a persistent subconscious's
  window), which the live rollback weighs, is neither counted in `returnedToArrivals` nor seen by this check; the
  refusal says so.

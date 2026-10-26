- A wake queued while a turn runs is no longer taken into the turn's
  context-budget restart when the restart is queued beside it, or released
  beside it by a provider hold. It waits for the restarted turn and then
  starts a turn of its own, as it does when a turn ends without a restart.
  Where the restart's turn already read the wake's message, that turn has
  nothing new to read, and its request ends on `[Continue]`: one more turn.
  A restart takes in no new input, so a coalesced batch the wake carried
  wasn't assembled there, and no turn of its own followed; and a silent
  turn's restart (`suppressProse`) that took an ordinary wake resumed with
  prose routing.

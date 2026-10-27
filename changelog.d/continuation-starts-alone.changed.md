- A wake queued while a turn runs is no longer taken into the turn's
  context-budget restart when the restart is queued beside it, or released
  beside it by a provider hold. It goes back to the queue and waits for the
  restarted turn, as it does when a turn ends without a restart. Then a wake
  that names its message is dropped once a request that carried the message
  has been answered (for a channel wake not marked ambient, once the agent
  has also spoken in that channel since), or once the message is gone from
  the store's current branch. Any other wake starts a turn of
  its own.
  A restart takes in no new input, so a coalesced batch the wake carried
  wasn't assembled there, and no turn of its own followed; and a silent
  turn's restart (`suppressProse`) that took an ordinary wake resumed with
  prose routing.

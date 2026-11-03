- `channel_close` of the channel an all-except hold excepts, while that
  hold's cancel waits (an operator's change to the store, or a context that
  refuses writes), now answers as the tune-out tools answer a cancel that
  waits. It says what the cancel waits for, that cancelling again doesn't
  end the wait sooner, that how long it lasts isn't known, and that a stop
  before it runs loses the cancel, so the hold is still in force after the
  restart unless its end time has passed.

- `skip_reply(wake_in_seconds)` now returns an explicit capability error when
  EventGate is not configured instead of ending the turn successfully without
  arming the promised wake.

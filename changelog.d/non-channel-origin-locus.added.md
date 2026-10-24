- **Modules:** `InferenceRequestEvent.callerTurnId`, the turn whose work the
  request continues, such as the turn that spawned a subagent whose result
  it is: the `callerTurnId` of the call that started the work, echoed back.
  A module's response that requests inference for the event wakes a private
  turn when that turn is private as it stands then, having taken in private
  input after the call included. The framework keeps the ids of its latest
  4,096 private turns, and an id no newer than one it has dropped counts as
  private. Left out, the wake is as before.

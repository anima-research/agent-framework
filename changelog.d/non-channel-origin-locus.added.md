- **Modules:** `InferenceRequestEvent.callerTurnId`, the turn whose work the
  request continues, such as the turn that spawned a subagent whose result
  it is: the `callerTurnId` of the call that started the work, echoed back.
  A module's response that requests inference for the event wakes a private
  turn when that turn is private as it stands when the wake's start reads
  it, having taken in private input after the call included, directly or
  after a gate debounce window.
  A message that brings the work back can carry the same id as its metadata
  key `callerTurnId` (`ModuleContext.addMessage`). If that turn is private
  when the message is stored, or when a tool boundary injects it, the
  message is private input: a turn that reads it is private, as one that
  reads a private surface's message is. The framework keeps the 4,096
  highest private turn ids, and counts as private an id no higher than one
  it has dropped, or one given out before it was made. A server's message
  can't carry the key. Left out, a request or a message is as before.

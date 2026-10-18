- Without an EventGate, `skip_reply` no longer offers `wake_in_seconds`; a
  positive timer argument supplied anyway is refused visibly without ending the
  turn, while ordinary `skip_reply` remains available.
- Without an EventGate, a `skip_reply` call stored in the agent's history keeps
  its `wake_in_seconds`, which the host used to delete from it (#394).

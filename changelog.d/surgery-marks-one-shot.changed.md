- Awareness marks are one-shot. Switching branches, undo/redo and restarts no
  longer add or remove marks; previously a mark followed the branch, removed
  when the source branch became active and re-added when the recovery branch
  did. Each request is written ahead of its dispatch. A request that went out
  and got no answer is recorded as `unknown`, and a later confirmation of a
  different attempt never resolves it. A batch whose surgery was interrupted
  before its branch switch was recorded is held at startup until an operator
  releases it.
- Awareness delivery no longer holds MCPL traffic. Previously every MCPL data
  plane waited at startup, at reconnect, at a tools list change and after each
  surgery until every queued mark had been attempted, which at Discord's pace
  could leave the resident deaf for minutes. Delivery now runs in the
  background. A route that is not connected keeps its work queued until it
  connects, and a delivery failure raises an ops alert instead of recycling
  connections. A journal that cannot be read still stops startup, because it
  also carries the suppression-resume record that protects the agent's
  context.

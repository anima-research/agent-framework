- **Hosts that build their own `EventGate`, and hosts and modules that read an
  `InferenceRequest`'s `wakeLines`, or a batched wake's `after` or
  `readsRow`:** a batched wake has no `[Gate: …]` line for an event with a
  message of its own in the window, so nothing is handed to the wake for its
  turn's start to write. Removed: `EventGate`'s `isNewestEntry` option,
  `WakeProvenance.line`, `InferenceRequest.wakeLines`, the `WakeLine` and
  `wakeLineText` exports, and the `gate:wake-line-omitted` trace. Migration:
  drop them. A batched wake no longer passes `requestInference`'s `after`,
  where 0.33.0 passed the placement of the line it wrote, and its
  `InferenceRequest` no longer carries `readsRow`: the writes it is for, its
  line's among them, are `provenance.writes`, and its rows are `readsRows` (in
  `.added`). A batch with an event in the window that was given no write of
  its own (`evaluate` without `after`) has no writes, so its wake is plain and
  starts its turn even once the agent has answered, where 0.33.0 marked it by
  the line it wrote, so it could drop once that line was answered. A host that
  handles `requestInference` itself and wants a batched wake dropped once the
  agent has answered it reads `provenance.writes`.

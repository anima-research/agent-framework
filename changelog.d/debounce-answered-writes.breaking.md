- **Hosts that build their own `EventGate`, and hosts and modules that read an
  `InferenceRequest`'s `wakeLines`:** a batched wake has no `[Gate: …]` line
  for an event with a message of its own in the window, so nothing is handed
  to the wake for its turn's start to write. Removed: `EventGate`'s
  `isNewestEntry` option, `WakeProvenance.line`, `InferenceRequest.wakeLines`,
  the `WakeLine` and `wakeLineText` exports, and the
  `gate:wake-line-omitted` trace. Migration: drop them. A host that handles
  `requestInference` itself and wants a wake dropped once the agent has
  answered it reads `provenance.writes` (in `.added`).

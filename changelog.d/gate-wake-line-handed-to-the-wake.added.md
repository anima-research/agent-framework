- `WakeProvenance.line` (optional) carries a batched wake's `[Gate: …]` line
  when the gate hands it to the wake rather than writing it (`WakeLine`, now
  exported: its event's entry, its policies, the channel it names and when
  the event arrived; `wakeLineText` renders it as of a time), and
  `InferenceRequest.wakeLines` carries it on the wake's request for the
  turn's start to write or leave out. A host that builds its
  own `EventGate` with `isNewestEntry` and handles `requestInference` itself
  receives the line there instead of in the window.

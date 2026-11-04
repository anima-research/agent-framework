- **Hosts that build their own `EventGate` and handle `requestInference`, and
  hosts that render an `InferenceRequest`'s `wakeLines` themselves:**
  `WakeProvenance.line` is now `lines`, a `WakeLine` per event of the batch;
  `WakeLine.shown` is absent for a quoted event; and `wakeLineText` takes the
  lines (`wakeLineText(lines, now)`). Migration: pass `provenance.lines` on as
  the request's `wakeLines`, and render with `wakeLineText(lines, now)`. The
  gate hands lines only to a host with `isNewestEntry`, and only for a batch
  whose every event has a write, each line carrying the write the host passed
  to `evaluate` (`after`, in `.added`), or, as before, for a single event
  still the newest entry, whose line carries its write where it has one. On a
  reply verdict, an event `isAnswered` counts as answered loses its write
  first. Dropping the wake once the agent has answered them is the
  scheduler's: AgentFramework's drops a request with `readsWakeLines: true`,
  and a host that runs its own judges the drop itself from each line's
  `after`.
  Unchanged: a host that gives the gate no `isNewestEntry` still has every
  batched wake's line written when the batch fires.

- A cancelled stream (host Stop button, `agent.cancelStream()`,
  `framework.abortInference()`) is no longer recorded as an inference
  failure. It emits `inference:aborted` instead of `inference:exhausted`,
  leaves the consecutive-failure streak and ops alerts untouched, and writes
  a `[turn-interrupted] … a deliberate stop, not a failure` chronicle marker
  in place of the `[inference-failed] the model call failed…` text with
  remediation advice for a failure that never happened. The marker names the
  act, not an actor (membrane's `user` reason means "the signal was aborted",
  not "the user did it"), and makes no claim about delivery. Callers can pass
  their own provenance — `cancelStream(reason)` / `abortInference(reason)` —
  which the trace and the marker's metadata carry; `abortInference` no longer
  emits a second `inference:aborted` on top of the stream driver's. (#134,
  by Lari; reworked after review.)
- Speech-route failures with no delivery locus (headless/WebUI turns with no
  home or trigger channel) now read `[send-undeliverable] … had no channel
  to go to` instead of claiming a Discord delivery failure to "the channel".
  The machine-readable marker `kind` is unchanged.

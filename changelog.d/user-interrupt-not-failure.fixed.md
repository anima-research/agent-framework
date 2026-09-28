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
  emits a second `inference:aborted` on top of the stream driver's. This
  holds on both of a stream's cancel twins: a stream implementation that
  reports `cancel()` through `error` rather than `aborted` reaches the same
  terminal (one `inference:aborted`, the marker, no `inference:failed`, no
  `errorPolicy` retry of the inference that was just stopped), and the
  quiesce/shutdown twins no longer emit a contradictory `inference:failed`
  before settling as aborted. A third shape — an implementation whose
  `cancel()` simply closes the iterator, with no terminal event — reaches the
  same terminal too, at the loop's end, instead of leaving the turn unsettled
  under a `completed` lifecycle terminal. (#134, by Lari; reworked after
  review.)
- Speech-route failures with no delivery locus (headless/WebUI turns with no
  home or trigger channel) now read `[send-undeliverable] … had no channel
  to go to` instead of claiming a Discord delivery failure to "the channel",
  and say that this route delivered nowhere rather than that the reply
  reached no one — another `dispatchSpeech` handler may have shown it. The
  machine-readable marker `kind` is unchanged.

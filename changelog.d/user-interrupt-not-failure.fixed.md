- A user-initiated stream stop (host Stop button / `cancelStream()`) is no
  longer recorded as an inference failure. It now emits `inference:aborted`
  (reason `user`) instead of `inference:exhausted`, leaves the
  consecutive-failure streak and ops alerts untouched, and writes an honest
  `[turn-interrupted]` chronicle marker ("deliberate cancellation, not a
  failure") in place of the misleading `[inference-failed] the model call
  failed…` text with remediation advice for a failure that never happened.
- Speech-route failures with no delivery locus (headless/WebUI turns with no
  home or trigger channel) now read `[send-undeliverable] … had no delivery
  destination` instead of claiming a Discord delivery failure to "the
  channel". The machine-readable marker `kind` is unchanged.
- The event gate's inference buffer no longer drops its oldest pending event
  silently when full: the drop is logged to stderr with the policy and event
  type. A dropped event never triggers inference, so a silent drop looked
  like "message sent, never answered, queue depth 0" from the outside.

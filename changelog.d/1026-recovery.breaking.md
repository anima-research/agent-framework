- **Hosts and operators using refusal auto-rewind, `/unstick` or exhaustion
  quarantine:** Safe B now declines incomplete/mismatched/mixed tool exchanges,
  unpresented endpoints, noncontiguous legacy removals and busy logical turns
  instead of shedding a single endpoint. Empty `/unstick` no longer opens a
  session. Registered-stream exhaustion may now quarantine only after settlement
  and terminal teardown, using the same failed attempt's compile witness; live
  streams still decline. Migrate by handling explicit declines, waiting for known work to
  settle and using the exclusive offline repair procedure in
  `docs/recovery-b.md` for interrupted or uncertain history. Do not repeatedly
  wake an uncertain store. Complete, unambiguous settled exchanges still support
  bounded recovery; ordinary inference/provider retries are unchanged. Requires
  context-manager 0.27.0+, chronicle 0.6.0+ and membrane 0.8.0+ (within the
  declared supported lines). Release in a new minor line, not a patch upgrade.

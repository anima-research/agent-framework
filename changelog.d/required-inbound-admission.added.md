- **Host applications:** opt into bounded, connection/epoch-bound inbound admission
  with `McplServerConfig.inboundAdmission`. Channel messages, pushes and inference
  requests are authorized before an asynchronous, fail-closed host callback.
  Unconfigured connections retain their existing behaviour without a preflight.
  Required traffic is held during startup staging and quiesce, then admitted at
  flush sequentially, preserving held-data order without overflowing admission
  slots. Held inference releases the drain after admission and synchronous provider
  dispatch, not after the full inference. New data joins an active drain; controls
  and RPC responses stay live. While a backlog drains, required data (held and
  newly arriving) is admitted one at a time, so sustained ingress above roughly one
  item per callback latency accumulates and is dropped/refused at the existing hold
  bounds. A bounded-concurrency ordered drain is a possible follow-up at the
  maintainer's discretion, not implemented here.
  Independently sent live items without a backlog may still finish in callback
  latency order. Superseded-epoch items are refused. During initialize, data requests
  receive the existing capability error (-32002). Required connections do not
  advertise `toolHints` or carry RFC-014 toolset presence; an explicit
  `toolHints: true` override logs once at connect. They refuse coalescing with `admission_unsupported` until
  durable re-admission is supported; generic result taps remain intact.
  `mayWake: false` caps downstream wakes, including module requests;
  `mayWake: true` does not override gate declines or prevent a module-driven wake.
  Admission refusals are traced with fixed codes and rate-limited diagnostics.
  The package exports read-only `admissionOf(event)`, `AdmittedEnvelope`,
  `AdmissionConnectError`, `MAX_ADMISSION_TIMEOUT_MS` and `MAX_PENDING_ADMISSIONS`.
  Missing bindings and attestation refusals abort startup even if cleanup also
  fails; ordinary transport failures keep the existing non-fatal startup and
  configured reconnect policy. Pending inference admission is cancelled by stop
  or transport closure, releasing its slot without waiting for a late callback;
  stop answers once and a closed transport gets no answer. Stamp support arrives
  with context-only delivery, not this profile. No SPEC change is required;
  a full MCPL pin follows separately. See `docs/required-inbound-admission.md`.

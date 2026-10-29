- **Host applications:** opt into bounded, connection/epoch-bound inbound admission
  with `McplServerConfig.inboundAdmission`. Required connections refuse pre-ready
  traffic, hinted pushes and standalone peer `tools/hints` instead of holding/replaying them.
  They ignore peer hints on pushes, standalone `tools/hints` and result-borne
  `mcpl/hints`. Their own solicited `tools/list` results still supply tool presence
  and `mcpl/rev` without admission, and may trigger host-to-peer list recovery
  because the host asked for the inventory: no wake, content delivery or stored
  data. Unconfigured connections retain their existing behaviour. Stamp support arrives
  with context-only delivery, not this admission profile. Missing bindings and
  attestation refusals abort startup; ordinary transport failures keep the existing
  non-fatal startup and configured reconnect policy. Pending inference admission
  is cancelled by stop or transport closure, releasing its slot without waiting
  for a late callback; stop answers once and a closed transport gets no answer.
  No SPEC change is required;
  a full MCPL pin follows separately.

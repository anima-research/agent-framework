- Refusal rewinds, `/unstick` and inference-exhaustion quarantine now plan whole
  complete tool rounds before mutation, retaining separate clock/lifecycle
  notices on presented windows. Legacy windows decline noncontiguous removal.
  Corrupt IDs (even adjacent), mixed/incomplete rounds and visibility barriers
  now explicitly decline unchanged rather than shedding a single endpoint.
  `/unstick` preflights before queuing; uncertain writes stop without replay.
  Empty/capped/unsupported attempts no longer clean up only the refused reply.
  See `docs/recovery-b.md` for compatibility losses and transaction limits.

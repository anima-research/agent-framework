- Refusal rewinds, `/unstick` and inference-exhaustion quarantine now plan whole
  complete tool rounds before mutation, retaining separate clock/lifecycle
  notices on presented windows. Legacy windows decline noncontiguous removal.
  Corrupt IDs (even adjacent), mixed/incomplete rounds and visibility barriers
  now explicitly decline unchanged rather than shedding a single endpoint.
  `/unstick` preflights before queuing; uncertain writes stop without replay.
  Empty/capped/unsupported attempts no longer clean up only the refused reply.
  See `docs/recovery-b.md` for compatibility losses and transaction limits.
- Automatic refusal rewind gets a fresh budget after giving up, for a later
  independent wake; giving up itself does not enqueue a retry. Existing markers
  remain, and removed/branched-away markers are replaced on the next supported
  step. Exhaustion quarantine waits for the ending stream's guard and pending
  assistant-round teardown before planning; unsettled asynchronous work still
  blocks it. Without a served-request set, only visible, reader-eligible calls
  lend result eligibility. Only results proven to answer hidden/foreign calls
  are skipped; visible orphan results stop recovery without removing unrelated
  older history or queuing a retry.
- Model-visible legacy rewind markers now say originals were removed from the
  raw record; presented-window markers continue to say originals remain there.
- A legacy removal confirmed by readback after a throwing write still propagates
  removal to other residents; automatic retry remains stopped. `/unstick`
  preflight now distinguishes wait-for-settlement from inspect/repair guidance.

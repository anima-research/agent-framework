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
  step. Active-stream exhaustion stops immediately for manual repair; it does
  not defer quarantine until teardown. Without an active stream, quarantine
  still requires logical quiescence and settled guard work. Without a served
  request set, only visible, reader-eligible calls lend result eligibility.
  Visible results matching only hidden/foreign calls also stop recovery without
  removing unrelated older history or queuing a retry.
- Model-visible legacy rewind markers now say originals were removed from the
  raw record; presented-window markers continue to say originals remain there.
- A legacy removal confirmed by readback after a throwing write still propagates
  removal to other residents; automatic retry remains stopped. `/unstick`
  preflight now distinguishes wait-for-settlement from inspect/repair guidance.

- Exhaustion requires full logical quiescence; active-stream failures decline
  for manual repair rather than deferring a plan to a different request/branch.
- Rewind notices are reused only at the presented tail. Give-up ends the episode;
  hidden, missing or non-tail notices start a fresh count without editing prefixes.
- Published repair guidance requires exclusive offline maintenance, not normal
  whole-turn undo; stopped forced recovery summaries no longer imply a retry.
- Confirmed refused-reply deletion after a throwing cleanup still retracts other
  windows; queued/held continuations also block terminal-refusal recovery.
- Tool IDs are matched within reader-owned live rounds, allowing reuse after
  completion, by another resident, or after undo. Unresolved reuse and duplicate
  results still decline; held/unpresented endpoints still participate in validation.

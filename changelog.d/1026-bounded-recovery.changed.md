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
  step. Exhaustion quarantine requires logical quiescence and settled guard
  work; registered-stream failures now retain their compile witness and may
  recover only after iterator completion, queued delivery and terminal teardown. Without a served
  request set, only visible, reader-eligible calls lend result eligibility.
  Visible results matching only hidden/foreign calls also stop recovery without
  removing unrelated older history or queuing a retry.
- Model-visible legacy rewind markers now say originals were removed from the
  raw record; presented-window markers continue to say originals remain there, including
  same-mode reuse; mixed-mode consolidation explicitly describes both outcomes.
- A legacy removal confirmed by readback after a throwing write still propagates
  removal to other residents; automatic retry remains stopped. `/unstick`
  preflight now distinguishes wait-for-settlement from inspect/repair guidance.

- Exhaustion requires full logical quiescence; genuinely live streams still
  decline. A settled terminal may recover only its own failed request/branch.
- Rewind notices are reused only at the presented tail. Give-up ends the episode;
  hidden, missing or non-tail notices start a fresh count without editing prefixes.
- Published repair guidance requires exclusive offline maintenance, not normal
  whole-turn undo; stopped forced recovery summaries no longer imply a retry.
- Confirmed refused-reply deletion after a throwing cleanup still retracts other
  windows; queued/held continuations also block terminal-refusal recovery.
- Tool IDs are matched within reader-owned live rounds, allowing reuse after
  completion or undo. Presented foreign observations do not reserve native IDs;
  legacy observed unresolved calls can still conservatively block ID reuse. Unresolved reuse and duplicate
  results still decline; held/unpresented endpoints still participate in validation.

- Legacy selection now uses the compile's recorded visibility, including ordinary
  co-resident own-row text; foreign tool closure still declines. Recovery's
  synchronous raw-history inflation is not window-bounded: a cold one-row plan
  over 32 MiB of historical image base64 measured 34–37 ms and about 33 MiB
  additional heap (about 81 MiB RSS). See `docs/recovery-b.md` for fixture scope,
  reproduction and the large-store/OOM risk.
- Forced-session summaries and budgets count confirmed exhaustion removals too;
  caller logs use their own confirmed-removal counts, not shared marker counts.

- Exhaustion witnesses now follow the exact failed request through later tool
  rounds, not just its initial compile. A caught speech-delivery rejection is
  not successful settlement; uncertain delivery disables quarantine for that
  Agent instance. Pre-stream failures also wait for preceding queued delivery.
  Shutdown closes quarantine admission as well as provider admission.

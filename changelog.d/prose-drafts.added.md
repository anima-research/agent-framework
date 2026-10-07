- **Held prose drafts: suppressed speech is kept, not destroyed.** Plain
  speech that is not sent is now held as a private draft with its exact
  words, instead of surviving only as a count: speech suppressed by an
  explicit send in the same round (locus and hybrid modes, mid-turn, trailing
  and text-only, native and XML tool modes), hybrid prose left without a
  destination after a failed envelope, and explicit/hybrid bounces (which
  replace the in-memory latest-wins clipboard; `{{unsent}}` keeps meaning the
  latest bounce). Deliberate privacy is never drafted: `skip_reply`, a
  same-round private `think`, silent turns and `proseRouting: disabled`
  narration stay private and are counted in the receipt.
- Drafts live in typed Chronicle records (`RecordJournal`) that do not follow
  branch switches: undo, rollback and checkout never change them, and they
  survive restarts. Nothing is ever sent from them on its own.
- A private notice names held drafts at the next tool boundary when the live
  stream presents mid-turn messages, and the turn-end `[delivered]` receipt
  names every draft held in the turn ("held as drafts d-…"); a draft no notice
  reached (a crash, an aborted turn) is named at the next turn's start.
- New `drafts` tool (whenever MCPL channels are configured): `list`, `read`,
  `resend` and `dismiss`, scoped to the calling resident. `resend` publishes
  drafts verbatim, in order, to one destination through the normal publish
  path, journaling each attempt durably before the request leaves; it counts
  as an explicit send. A delivered draft returns its historical receipt
  instead of sending again; a draft whose last attempt's outcome is unknown
  needs `confirmDuplicate: true`. Unused fields may be passed as null.
- `ChannelRegistry.deliverSpeech` (routeSpeech with its `PublishOutcome`) and
  `ChannelRegistry.resolveDestination` are new; routeSpeech is unchanged.
- The bounce notice now goes to the bouncing resident rather than the primary.

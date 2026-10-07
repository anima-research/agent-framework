- **Held prose drafts: suppressed speech is kept, not destroyed.** Plain
  speech that is not sent is now held as a draft with its exact words,
  instead of surviving only as a count: speech suppressed by an
  explicit send in the same round (locus and hybrid modes, mid-turn, trailing
  and text-only, native and XML tool modes), hybrid prose left without a
  destination after a failed envelope, and explicit/hybrid bounces (which
  replace the in-memory latest-wins clipboard; `{{unsent}}` keeps meaning the
  latest bounce). A draft held beside a send keeps its run exactly as
  written, indentation and surrounding newlines included; routing still
  publishes trimmed segments. Deliberate privacy is never drafted:
  `skip_reply` (the tool, or a hybrid `>>>skip_reply` envelope, which keeps
  the rest private until a destination is named), a same-round private
  `think` in a native round (where that policy applies: XML tool mode routes
  such prose as ordinary speech, so a send holds it as a draft), silent turns
  and `proseRouting: disabled` narration stay private and are counted in the
  receipt.
- In hybrid mode a send withholds publication, not what an envelope does: a
  held `>>>` envelope moves the routing state as live routing would (a
  destination it names becomes the sticky target), `>>>skip_reply {{unsent}}`
  still sets the latest bounce aside, and the draft holds the message the
  envelope would have published, with `{{unsent}}` expanded under the
  re-bounce rule (a bare `{{unsent}}` leaves the bounce as the one draft).
- Drafts live in typed Chronicle records (`RecordJournal`) that do not follow
  branch switches: undo, rollback and checkout never change them, and they
  survive restarts. Nothing is ever sent from them on its own.
- A private notice names held drafts at the next tool boundary when the live
  stream presents mid-turn messages (a draft holding words copied from one
  that may already have been posted is named with that risk and the
  `confirmDuplicate` its resend needs), and the turn-end `[delivered]` receipt
  names every draft held in the turn by its state at turn end: still held
  ("held as drafts d-… (not sent …)"), delivered by the resident's resend
  (listed where it landed), unconfirmed, or dismissed. A draft no notice
  reached (a crash, an aborted turn) is named at the next turn's start.
- A draft is never published except by its resident's explicit resend (or
  `{{unsent}}`), and only that resident can list or act on it. Its notices go
  into the resident's own history, which residents sharing one message slot
  already share, as they share the assistant turn the words came from.
- New `drafts` tool (whenever MCPL channels are configured): `list`, `read`,
  `resend` and `dismiss`, scoped to the calling resident. `resend` publishes
  drafts verbatim, in order, to one destination through the normal publish
  path, journaling each attempt durably before the request leaves; it counts
  as an explicit send. A delivered draft returns its historical receipt
  instead of sending again; a draft with any attempt whose outcome is
  unknown (and none confirmed) needs `confirmDuplicate: true`, and a resend
  owns its drafts until it finishes, re-checking each before it is sent.
  Unused fields may be passed as null.
- Prose segments also break at XML tool mode's refused attempts and their
  notices (`tool_attempt`, `tool_notice`): the words before an all-refused
  call and after its notice are two messages, routed or held separately.
- `ChannelRegistry.deliverSpeech` (routeSpeech with its `PublishOutcome`) and
  `ChannelRegistry.resolveDestination` are new; routeSpeech is unchanged.
- The bounce notice now goes to the bouncing resident rather than the primary.

- **Held prose drafts: suppressed speech is kept, not destroyed.** Plain
  speech that routing holds back is now held as a draft with its exact
  words, instead of surviving only as a count: speech suppressed by an
  explicit send in the same round (locus and hybrid modes, mid-turn, trailing
  and text-only, native and XML tool modes), hybrid prose left without a
  destination after a failed envelope, and explicit/hybrid bounces, a
  delivery that definitely failed among them (which replace the in-memory
  latest-wins clipboard; `{{unsent}}` keeps meaning the latest bounce). Locus
  speech whose delivery fails keeps its failure marker, and isn't held. A draft held beside a send keeps its run exactly as
  written, indentation and surrounding newlines included; routing still
  publishes trimmed segments. Deliberate privacy is never drafted:
  `skip_reply` (the tool, or a hybrid `>>>skip_reply` envelope, which keeps
  the rest private until a destination is named), a same-round private
  `think` in a native round (where that policy applies: XML tool mode routes
  such prose as ordinary speech, so a send holds it as a draft), silent turns
  and `proseRouting: disabled` narration stay private.
- In hybrid mode a send withholds publication, not what an envelope does: a
  held `>>>` envelope moves the routing state as live routing would (a
  destination it names becomes the sticky target), `>>>skip_reply {{unsent}}`
  still sets the latest bounce aside, and the draft holds the message the
  envelope would have published, with `{{unsent}}` expanded under the
  re-bounce rule (a bare `{{unsent}}` leaves the bounce as the one draft).
- Drafts live in typed Chronicle records (`RecordJournal`) that do not follow
  branch switches: undo, rollback and checkout never change them, and they
  survive restarts. Nothing is ever sent from them on its own. Each
  resident's 100 newest drafts are kept, and an older one for at least 7
  days after anything last happened to it (held, named, attempted, answered,
  dismissed). The journal lets such a draft go when it next checkpoints what
  it keeps, every 500 entries, so opening it replays only what follows. A request naming a draft that was let go is
  refused, and nothing is sent, unless that id has since been given to a newer draft,
  which the request then names instead: an id is `d-` and seven characters, so after N more of its resident's drafts a let-go id has come back
  with a probability of about N in 2.75 × 10^10.
- A private notice names held drafts at the next tool boundary when the live
  stream presents mid-turn messages (a draft holding words copied from one
  that may already have been posted is named with that risk and the
  `confirmDuplicate` its resend needs). In locus and hybrid modes the
  turn-end `[delivered]` receipt names every draft held in the turn, in any
  of its streams (a framework retry, or the compile a provider-capacity hold
  defers the turn to), by id and by its state at turn end: still held
  ("held as drafts d-… (not sent …)"), delivered by the resident's resend
  (listed where it landed), unconfirmed, or dismissed. A dismissed draft
  whose own attempt may already have been posted is named with that risk,
  and counts like an unconfirmed one: a receipt that names one, with nothing
  confirmed delivered, reads "nothing confirmed", not "nothing". Explicit
  mode writes no receipt: its drafts are named by their bounce and refusal
  notices. A draft counts as named while a message naming it is on the
  current branch, so one no notice reached (a crash, an aborted turn), or
  whose notices a rollback or branch move took away, is named at the next
  turn's start: every such open draft by id, the newest eight with its state
  and why it was held. That catch-up reads the recent history (the newest
  500 messages): it records a notice it finds there, including one that
  landed after its turn had ended, and it leaves out the drafts of a turn
  still open and those a notice waiting to be written names. Notices
  name drafts and say how to resend or dismiss them, and quote none of their
  words; the `drafts` tool's `read` shows the words, and its `list` a
  preview of each.
- A draft is never published except by its resident's explicit resend (or
  `{{unsent}}`), and only that resident can list or act on it. Its notices go
  into the resident's own history, which residents sharing one message slot
  already share, as they share the assistant turn the words came from.
- New `drafts` tool (whenever MCPL channels are configured): `list`, `read`,
  `resend` and `dismiss`, scoped to the calling resident. Every such
  resident's tool list gains it, so each one's first request after upgrading
  misses the prompt cache once. `resend` publishes
  drafts verbatim, in order, to one destination through the normal publish
  path, journaling each attempt durably before the request leaves; it counts
  as an explicit send. A delivered draft returns its historical receipt
  instead of sending again; a draft with any attempt whose outcome is
  unknown (and none confirmed) needs `confirmDuplicate: true`, and a resend
  owns its drafts until it finishes, re-checking each before it is sent, and
  a draft it doesn't attempt is told why the batch stopped. Dismissing a
  draft (with the tool or `>>skip_reply {{unsent}}`) is refused while that
  draft's attempt is out, since a dismissal can't call back words already on
  their way; the resident is told to wait for that result. A draft only
  queued in a resend can still be dismissed, and is then not sent. A
  dismissal of a draft that may already have been posted names that risk.
  Unused fields may be passed as null.
- `{{unsent}}` whose draft is being sent, queued in a resend, or unconfirmed
  sends nothing, and the envelope's own words are held as a bounce draft
  with `{{unsent}}` written out and the risk carried, so nothing the
  resident wrote has to be typed again. If the journal refuses that draft,
  the notice says the words remain only in the history.
- Prose segments also break at XML tool mode's refused attempts and their
  notices (`tool_attempt`, `tool_notice`): the words before an all-refused
  call and after its notice are two messages, routed or held separately.
- `ChannelRegistry.deliverSpeech` (routeSpeech with its `PublishOutcome`) and
  `ChannelRegistry.resolveDestination` are new. `routeSpeech` now delegates
  to `deliverSpeech` and returns null unless delivery was confirmed, so a
  missing receipt and a channel id two servers share now return null (see
  the publish-outcomes entry).
- The bounce notice now goes to the bouncing resident rather than the primary.

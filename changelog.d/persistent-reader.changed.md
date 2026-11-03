- **Hosts with a `dendrite.derivationNotice`: resumptions count toward `collapseDerivationNoticesAfter`.** Every
  resumption was told to the source with a line of its own. Now each incarnation from a source is tallied with its
  kind's derivations, so past the threshold a resumption, like a derivation, is told in the count line every so many.
  The first `collapseDerivationNoticesAfter` incarnations of a kind are still told one by one. A count line that
  includes resumptions says how many (`… has been derived from you, and resumed 3 times, since …`), and its
  `dendrite.collapsed` carries `resumed`; one with none reads as before.
- A shared derivation resumed with `resumeAgent` on its source's `allowedTools`, while the source is registered, shows
  the source's tool presentation again, as its derivation did, so its tool block is the source's. Before, a resumed
  fork of a resident with a `toolPresentation` was shown its own tool block. A resumed candidate's `cleanup()` takes
  that out only while the candidate is still the one being resumed, so an earlier incarnation's cleanup leaves a later
  one's.
- `derivationNotice`'s default line for a persisted reader (a `subconscious-fork` record whose metadata has `persist`
  `'epoch'` or `'resident'`) says what it reads: `reading your context up to the point it was derived, and at each look
  handed an account of the messages your context took since the look before (not your stored context injections)` at
  a resumption. Every other record's line reads as before, whatever metadata the host gave it.
- A persisted reader's resync (`resync: 'window'`) is bounded by `subconscious.resyncLimit` (`{ rows?, chars? }`, whole
  numbers): a resumed look is handed the newest rows that fit, whole. `chars` counts them as `defaultReaderFraming`
  writes them; left out, it is the reader's strategy's per-message room (`maxMessageTokens` × 4) less the rest of the
  default framing at that look, so the framing row isn't cut by the strategy, which keeps a message's first characters
  and would otherwise lose the newest rows and the held traffic after them. A strategy with no per-message cap gives no
  bound. `ReaderFramingContext.residentRowsOmitted` counts the older rows left out, and the default count line says so:
  `[In <resident>'s context since your last look: 812 messages; the oldest 600 are not shown here]`. The framing's mark
  is the window's end either way, so a row left out is handed at no later look.
- A resumed look whose resident rows can't be read (the resident's window isn't presented, or no framing on the reader's
  branch records where it stood) has `ReaderFramingContext.residentRowsUnavailable` (`'not-presented' | 'no-mark'`),
  and the default framing says `[What entered <resident>'s context since your last look could not be read; none of it
  is shown here.]`; its `tune-out:reader-fork` leaves `resynced` out.
- A persisted reader's framing row records the incarnation it was made for (`metadata.incarnation`). A refused
  resumption gives its held rows back each time it is refused: a framing no run took on no longer keeps them from the
  coordinator, though the next run that takes the reader on reads that framing, and is not handed them twice. A framing
  an undo took out of the reader's window counts as handing nothing.
- A generation of a persisted reader counts as used when the registry has a record of it or the store a branch its
  derivation made (`dendrite/<name>`, or `~n` after it). After a restart, a generation whose run was refused no longer
  hides a later one that ran, and a generation whose record the registry can't reach is derived again under the next
  name and traced `tune-out:reader-rederived` (`'no-record'`), not again under its own.
- A persisted reader's look that fails while it is planned, or whose resident ended while it waited, gives its held rows
  back and emits `tune-out:reader-fork-failed` under the identity's name (`reader/<resident>` or
  `reader/<resident>/<epoch8>`); the second's error is `the resident ended before the look ran`. A resumed look fails
  the same way when the host's branch moved while the reader was reopened, and the next look plans on the new branch.
- `stop()` waits for persisted-reader looks (bounded by `teardownTimeoutMs`), and a look still queued when it begins
  derives, resumes and traces nothing.
- Each persisted-reader look counts only its own `deliver_summary` as its report, so a run the host resumed the reader
  for between looks doesn't suppress the next look's prose report.
- `tune_out`'s sentence for a persisted reader says `each handed an account of the messages your context took since the
  run before (not your stored context injections)`, and with `'epoch'`, `a new fork is made when it can't be resumed, or
  for a run after the tune-out ended`.

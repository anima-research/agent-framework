- **Residents:** a turn whose inference is exhausted before it got partway
  writes no `[inference-failed]` note into the agent's context. Partway means
  one of its rounds reached the context with its results, or had its tool
  calls started and cut off. Everything else its failure does is as
  before: stderr's `[inference-failed] agent=…` line, `failures.log`'s
  `inference-exhausted` record, the consecutive-failure streak, the
  `inference:exhausted` trace, the hard-down alert, and the poison-history
  breaker, whose `[refusal-rewind]` note carries the failure's reason when
  it sheds history. So a failure that comes back at every turn's first
  call, such as a provider that's down or a context that's too long, no longer
  adds a note per turn to the context it's sent with (#979).
  - A turn that got partway still gets one note, which says how far it got
    (its earlier rounds ran, or a round's tool calls were started and may
    have taken effect) and the reason, without the advice
    "If this recurs with the same cause, change approach rather than retrying
    identically (e.g. drop an oversized attachment or an unsupported
    setting)." A timed-out turn's note keeps "If a reply is still owed from
    that turn, you can give it now."
  - The reply judge reads the agent's context, so it no longer sees an
    `[inference-failed]` note for a turn that did nothing.
  - `SUPPRESS_INFERENCE_FAILED_MARKER=1` now leaves out only that note, since
    no other is written.
  - Notes already in a store stay as they are.
  - What this changes in what's published:
    - README, a turn's call a bound cuts: "A fresh call that's cut too, with
      no other failure between, ends the turn, and its `[inference-failed]`
      note says the call timed out, that the call was made again and timed
      out again, and the reason" now reads that the turn's note says so if
      the turn got partway, and that a turn that did nothing gets no note.
    - README, after the failure and stop notes: a new paragraph says when the
      note is written, as above.
    - `FrameworkConfig.exhaustedTurnRearmMs`'s doc: "A re-armed turn's
      transient failure writes no `[inference-failed]` marker unless a round
      of it ran or had its tool calls cut off; any other failure of it writes
      one." Now a failure of a re-armed turn writes a note only when a round
      of it ran or had its tool calls cut off, as any turn's failure does.
    - 0.22.1: "a non-retryable failure that states a wait keeps its terminal
      disposition (its marker and failure count)". Now such a failure keeps
      its failure count, and its marker only when its turn got partway.
    - 0.29.0: "A re-armed turn's transient failure writes no
      `[inference-failed]` marker unless it got partway, so the agent's
      context keeps the one the first exhaustion wrote; a failure of another
      kind writes its own." Now no failure of a turn that didn't get partway
      writes one, the first exhaustion's included, whatever its kind.
    - 0.31.0: "A turn that ends on a timeout says so in its
      `[inference-failed]` note: the model call timed out, or its last call
      did … Other failures keep their wording and advice." Now only a turn
      that got partway has the note, which says its last call timed out, and
      no failure's note carries the advice.
    - The `[assistant-persist]` stderr line for a thinking-only reply the
      store refuses ended "— the turn produced no output. See the
      refusal/inference-failed record for why.", though a turn whose earlier
      rounds ran produced output, and a refusal never wrote an
      `[inference-failed]` note. It now ends "(… no text and no tool_use).
      If it was refused, see its [inference-refusal] line and failures.log
      record."
    - Earlier entries' wording of the note for a turn that did nothing ("the
      model call failed … and produced no response, so nothing was sent")
      describes only notes already in stores.

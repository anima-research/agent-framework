- `subconscious.reader: 'forks'` (Dendrite): the tune-out reader as a succession
  of forks of the resident instead of one persistent side-agent. Each cadence
  tick, coalesced wake and cancel derives a short-lived `subconscious-fork` at
  the resident's head — its history as the fork's own turns, its refusal ledger,
  its tools and system prompt, ending with it — hands it the traffic held since
  the last look as ordinary framing (each held message to exactly one fork, media
  preserved), including messages still queued behind a resident turn that is
  running, which `ReaderInvocation.queued` and `ReaderFramingContext.queued`
  carry, and lets it report through `deliver_summary` as attributed mail
  under the fork's name and incarnation. In this mode `subconscious.model` is
  required (whose weights read the resident's prefix is never defaulted; the
  resident's own model makes the fork a copy, another model by name is allowed)
  and `subconscious.voice` is the reader's framing block in place of
  `systemPrompt`. `subconscious.strategyFactory` supplies a fresh strategy
  instance for each fork (required for a folding resident);
  `subconscious.forkIdleTimeoutMs` bounds one fork (default 10 minutes);
  `subconscious.framing(context)` decides how a fork is prompted, with
  `defaultReaderFraming` exported as the default. A cadence period with nothing
  new derives no fork. A reader's own cancel is followed by one more fork only
  for messages that arrived after the reader was handed its own. New trace
  `tune-out:reader-fork` (`held`, of which `queued`). `reader: 'persistent'`
  remains the default and is unchanged.

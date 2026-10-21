- **Hosts:** agent-framework now depends on membrane `^0.6.0` and
  context-manager `^0.18.0`, where it depended on `^0.5.87` and `^0.14.1`.
  context-manager 0.18.0 requires membrane `^0.6.0` itself, so the two
  install one membrane between them. What reaches a host through
  agent-framework, from those releases' notes:
  - **Your own membrane:** a host that builds its own `Membrane` and hands it
    to agent-framework raises its own `@animalabs/membrane` range to
    `^0.6.0`. context-manager counts a compression attempt's prompt through
    that instance, and with an older membrane it counts Gemini's cached input
    twice (below 0.5.81, OpenAI's too, and OpenRouter's on routes that report
    OpenAI's `cached_tokens`), so a compression fallback that fits can be
    rejected at admission and its chunk quarantined (context-manager 0.16.0).
  - **Your own context-manager:** a host that constructs strategies from its
    own `@animalabs/context-manager` must also raise that range to `^0.18.0`,
    matching agent-framework's dependency, and verify that installation has
    one compatible copy. Leaving the host on 0.14.x installs two copies and
    hands an older strategy to a newer manager; strategy interfaces and
    compression-pause/quarantine behavior differ between those versions.
  - **The kv-unified hysteresis certificate is on by default** for a
    strategy built from a recipe: a `kvUnified` block without
    `hysteresisCertificate` takes the certified exit, and
    `hysteresisCertificate: false` restores the full solver on every compile
    (context-manager 0.15.0).
  - **Content context-manager won't store** is refused where agent-framework
    writes it, as the entry on malformed content says.
  - **Stored history:** content an older context-manager stored that doesn't
    match `ContentBlock` is now read mended, or left out, with one line per
    message naming each place, where some such content made every compile
    throw. A `tool_use` stored with `input: null`, as membrane 0.5.87's
    OpenAI-family adapters gave it for the arguments `null`, reads as `{}`
    with `null` in `unparseableInput`. A request compiled from such a message
    can change there, so a provider's prompt cache misses from that point,
    once (context-manager 0.16.0).
  - **Tools given `null` arguments:** an OpenAI-family tool call whose
    arguments are the text `null` reaches the tool as `{}`, where it reached
    it as `null`. membrane keeps the arguments' text on the `tool_use` block
    as `unparseableInput` (membrane 0.6.0).
  - **Anthropic streams:** after a stream's first event, SSE `ping`
    keepalives now count as activity for its idle deadline, so a stream that
    keeps sending only pings no longer ends at it (membrane 0.6.0).
  - **Media notes:** two of the notes membrane writes in place of media it
    doesn't send now say the model isn't seeing it. The first request after
    upgrading carries the new text wherever it renders such a note, so a
    provider's prompt cache misses once, from the first such note on
    (membrane 0.6.0).
  - **Caller-supplied blob references:** context-manager 0.16.0 and later refuse
    `blob_ref` writes with `MalformedContentError`; these references are
    store-internal. Read with blobs resolved (the default) before copying a
    body into a new write. An unresolved read is not a write-ready payload.
  - **Compression quarantine status:** callers that inspect or compare
    `getCompressionQuarantineStatus()` must account for its `spans` field,
    including an empty array when no spans are quarantined.
  - **kv-unified policy:** context-manager 0.17 adds age bands, joint latent
    demand and the subtree engine. Explicit recipe overrides remain important:
    `policy.ageBandSteps: 0` requests exact ages, `latentDemandMode: 'individual'`
    chooses independent ranking, and `engine: 'dag'` selects the DAG engine.
  - **Merges across an unowned message:** the floor is 0.18.0, not 0.17.x,
    because before it a merge could group the summaries on either side of a
    message no chunk owns (a raw pin, a message an unpin freed, or a head
    window `resetHeadWindow` left mid-stream), and under kv-unified without
    `treeifyNonContiguousSummaries` or `preserveGapBearingSummaries` every
    compile after it threw `CanonicalForestError`. A store already holding
    such a summary loads as before (context-manager 0.18.0, #287).
  - **`close()` is final:** after a context manager's `close()`, every
    operation that writes or calls into its strategy throws, with an
    app-owned store too; open a new manager on the store to go on with it
    (context-manager 0.18.0).
  - **Compression debt:** `getCompressionDebt()` answers `unknown` when it
    can't read what decides its state, with `null` for each count it couldn't
    compute and an operator-facing `error`. A host that shows the report
    treats `unknown` as needing attention and never shows a `null` count as
    0 (context-manager 0.18.0).
  - **Strategy subclasses:** `AutobiographicalStrategy`'s protected
    `pruneToolEntries` is removed; override `toolPruning` or `prunedForSend`
    instead (context-manager 0.18.0).
  - The rest is in membrane 0.6.0's notes and context-manager 0.15.0's,
    0.16.0's, 0.17.x's and 0.18.0's.

- An `afterUser` context injection, a module's `gatherContext` or an MCPL
  `beforeInference` hook's, is appended to the agent's window at the start
  that gathers it, as the message `compile()` would have placed
  (participant `system_context:<namespace>`), so it stays where the agent
  saw it. Where the window ends on a user message, as at a turn's start and
  a restart after tool results, that's where `compile()` placed it.
  Before, `compile()` placed it after the newest user message at each
  start, so it moved every turn and at each restart after a tool result:
  every reply after its old place lost its thinking on a model that binds
  thinking to everything before it, and the previous turn's cached prefix
  was rewritten. The first start after upgrading stores each
  injection once, so that request's cached prefix ends where the injection
  used to be placed.
  - **What's stored again:** a source's unchanged content isn't stored again
    while the copy the agent will read as current has it whole: the one its
    last request held, or a newer one a start stored whose compile then
    didn't record (it threw, or the start failed before it). An injection that would
    leave nothing in a request (no block but blank text) isn't stored, and
    is placed as before. Changed content is appended then (see where it
    lands, below), and the earlier copy stays, so each change adds a row
    until a fold summarizes it. A copy a fold has summarized, or a
    strategy's window has passed, is stored again, as one more row, at the
    start after the first request that no longer holds it, so that one
    request has the summary's word for it, or, past the window, goes
    without it. So is one after the host restarts or the window changes
    branch. A copy a start stored whose compile then threw isn't stored
    again by an error policy's retry of that start, since no request has
    had it yet, and content that changed back while a compile failed is
    stored again (where the window can't be read then, one request later).
    A copy the strategy cut
    at its per-message cap counts as held, since a new one would be cut the
    same. A copy whose source stops giving it stays in the window until a
    fold, where before it was gone at once.
  - **Where it lands:** appended to the window. Where the window ends on the
    agent's own reply (a wake with nothing new), a changed injection lands
    after that reply, and `[Continue]` still ends the request, after it.
    Where another participant spoke last (another resident, a visitor),
    the request ends on the injection, after that message; `compile()`
    placed it after the last user message, before it.
    `system` and `beforeUser` injections are placed by `compile()` as
    before. While the host is quiesced, or another reader of the residents'
    shared slot has a turn alive, nothing is stored: `compile()` places a
    changed one.
    A request that ends on an injection `compile()` placed (in a window
    with no user message, or a held window where a changed injection is
    placed rather than stored) gets no `[Continue]` after it, and a tool
    loop's prompt doesn't carry past it, as before.
  - **A stored injection is history to the strategy:** it's sharded,
    selected by the budget and folded like any message, where a placed one
    went whole. Under the windowed-passthrough strategy, an injection larger
    than `maxMessageTokens` reaches the request cut to it, with the cap's
    omission marker. The autobiographical strategy, with
    `adaptiveResolution` on, stores a message over twice
    `targetChunkTokens` in shards of about `targetChunkTokens` each, and
    caps each shard on its own.
  - **Host authors:** a stored injection is a row of the agent's window, so
    `getAllMessages`, `queryMessages` and a module's reads return it. Its
    metadata carries `system: true`, `kind: 'context-injection'` and
    `contextInjection: { agent, namespace, contentHash, part, parts }`. The
    newly exported `storedInjectionMarkOf` reads it as the framework's own
    views do. A reader that answers "what did someone say" should leave such
    rows out. Every other agent's view (another resident sharing the slot,
    the subconscious) leaves them out, and a conversation fork's seed leaves
    out its template's, though a summary that folded one in is seeded as
    summaries are. The history module's semantic index leaves their rows
    out, though a summary that folded one in is indexed as summaries are; its
    `extract`, `search`, `stats` and `overview` list them under their
    participant, as they list clock rows, every resident's in a shared slot,
    and a channel-filtered read leaves them out, as they carry no channel.
  - **Module authors:** `gatherContext` returns `ModuleContextInjection[]`,
    whose `placedEachCompile: true` keeps an injection placed by `compile()`
    at each start, near the end, as before, at the cost of the thinking of
    every reply after its old place. It's for context meant to stay near the
    end, such as instructions moved off `system`. An existing module's
    `ContextInjection[]` is still accepted. An MCPL server's injection can't
    opt out.

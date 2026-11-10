- **Hosts that rely on `maxStreamTokens`'s restart:** a turn can now go on
  past `maxStreamTokens` without restarting. At a tool boundary past it, the
  restart is declined where context-manager's preview of its compile says
  the compile won't fit and doesn't name compression as what would make
  room. It is declined too where the preview meets a drop no summary covers
  while no compression is pending. For an agent the budget hold can't take,
  such as an ephemeral run, a preview that won't fit declines the restart
  even where it names compression, and so does an uncovered drop while
  compression is pending. The stream then goes on, and the boundary emits an
  `inference:restart_declined` trace saying why. A later boundary past
  `maxStreamTokens` considers the restart again. Every other restart is
  taken as before, including one whose preview names compression as what
  would make room for an agent the hold can take, and one whose preview
  fails.
  - **What it trades:** before this release, a restart the preview now
    declines was taken. For an agent the budget hold could take, its compile
    refused, and while compression was pending the turn waited in the hold
    and its restart ran again later. Otherwise the turn ended with an
    `over_budget` failure row, or a `context_refusal` one for a drop no
    summary covers. For an agent the hold can't take, the compile could
    still fit if compression pending at the boundary landed before it. If
    not, the run ended with the compile's failure. The hold takes a
    registered agent's turn while the framework runs, and never an ephemeral
    run's. Now the stream goes on with the turn's rounds whole, and the turn
    isn't held. An ephemeral run's compression doesn't wait on a provider
    gate, so compression landing while its stream goes on moves the kept
    decline's counts, and a later boundary takes the restart if its compile
    then fits.
  - **What it costs:** under a strategy that previews, a restart past
    `maxStreamTokens` that is taken runs its compile's select twice, once
    for the preview, and the preview is synchronous, so nothing else on the
    host's event loop runs meanwhile. A strategy with no preview, such as
    `PassthroughStrategy`, pays nothing more.
  - **Migration:** with `physicalWindowTokens` unset, nothing else bounds a
    declined stream. It can go on until the provider refuses a request at
    its own window. The turn then ends with a `context_length` failure row,
    which raises the `context-refusal` ops alert and kicks the compression
    drain, as a refused compile does. Set `physicalWindowTokens` below the
    provider's window, with a `contextBudgetTokens` the window can hold, to
    restart the stream before a request the window can't hold. That restart
    is taken whatever its compile would do, as before this release.
  - **A host whose `contextBudgetTokens` bounds what a request costs,**
    rather than the provider's window: a declined stream's requests can now
    grow past that budget toward the provider's window.
    `physicalWindowTokens`, set below the provider's window, bounds them
    instead, once a call of the stream has reported its prompt.
  - **A restart the window projection forces** is the window's even where
    the stream is past `maxStreamTokens` too. Its
    `inference:stream_restarted` trace gives the reason `physical_window`,
    with the projection as `inputTokens` and `physicalWindowTokens` as
    `budget`, and the stream's inference-log entry has the `stopReason`
    `physical_window`. Before this release such a restart had
    `context_budget`, with the stream's count and `maxStreamTokens`.
  - **With a turn's pin on the rows it opened with**
    (`agent-framework:turn-inputs`), the preview answers whether the
    restart's compile would fit were those rows unpinned, and unpins
    nothing. A declined restart keeps the pin, so the stream that goes on
    keeps those rows raw.
  - **Unchanged:** the `physicalWindowTokens` restart; a strategy with no
    preview (such as `PassthroughStrategy`), which restarts as before; and a
    boundary past `maxStreamTokens` while the framework stops, which ends
    the turn with its stream.
- **Hosts with a table or `switch` that must cover every `TraceEvent['type']`:**
  the union names one more type, `inference:restart_declined`, so a
  `Record<TraceEvent['type'], …>`, or a `switch` checked exhaustively with
  `never`, needs an entry for it.

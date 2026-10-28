- **Hosts that rely on `maxStreamTokens`'s restart:** a turn can now go on
  past `maxStreamTokens` without restarting. The restart is declined when
  context-manager's preview of its compile says it won't fit, or the
  preview fails: the stream goes on, each boundary that declines it emits
  an `inference:restart_declined` trace, and the next tool boundary over
  the budget considers the restart again. On 0.28.0 the restart was taken
  whatever its compile would do, and a compile that couldn't fit refused,
  so the turn ended with an `over_budget` failure row.
  - **Migration:** with `physicalWindowTokens` unset, nothing else bounds a
    stream whose restart is declined: it can go on until the provider
    refuses a request at its own window, and the turn then ends with a
    `context_length` failure row. That ending raises the `context-refusal` ops alert and
    kicks the compression drain, as 0.28.0's refused compile did. Set
    `physicalWindowTokens` to restart a stream before a request its window
    can't hold, with a `contextBudgetTokens` the window can hold. That
    restart is taken whatever its compile would do, as on 0.28.0, so one
    that can't fit refuses, and the turn ends with an `over_budget` failure
    row.
  - **A host whose `contextBudgetTokens` bounds what a request costs,**
    rather than the provider's window: on 0.28.0 a stream past
    `maxStreamTokens` always restarted into a compile held to that budget,
    and now a declined restart lets the stream's requests grow toward the
    provider's window. `physicalWindowTokens` bounds them instead: set below
    the provider's window, it restarts the stream before a request it
    projects past it, once a call of the stream has reported its prompt,
    whatever that restart's compile would do.
  - **The preview can't count the rows the restart's start then stores,**
    such as new or changed afterUser injections, so a restart whose preview
    leaves less room than those rows take can still be refused, and the
    turn then ends with its failure row.
  - **A restart the window projection forces** is the window's even where
    the stream is past `maxStreamTokens` too: its `inference:stream_restarted`
    trace gives the reason `physical_window`, with the projection as
    `inputTokens` and `physicalWindowTokens` as `budget`, and the stream's
    inference-log entry the `stopReason` `physical_window`. 0.28.0 gave such
    a restart `context_budget`, with the stream's count and
    `maxStreamTokens`.
  - **Unchanged:** a restart whose preview fits, the `physicalWindowTokens`
    restart, a strategy with no preview (such as `PassthroughStrategy`),
    which restarts as before, and a boundary past `maxStreamTokens` while
    the framework stops, which ends the turn with its stream.

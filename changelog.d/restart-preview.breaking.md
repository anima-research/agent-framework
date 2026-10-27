- **Hosts that rely on `maxStreamTokens`'s restart:** a turn can now go on
  past `maxStreamTokens` without restarting. The restart is declined when
  context-manager's preview of its compile says it won't fit, or the
  preview fails, which is logged: the stream goes on, and the next tool
  boundary over the budget considers the restart again. On 0.28.0 the
  restart was taken whatever its compile would do, and a compile that
  couldn't fit refused, so the turn ended with an `over_budget` failure
  row.
  - **Migration:** with `physicalWindowTokens` unset, nothing else bounds a
    stream whose restart is declined: it goes on until the provider refuses
    a request at its own window, and the turn ends with its failure row. Set
    `physicalWindowTokens` to restart a stream before a request its window
    can't hold, with a `contextBudgetTokens` the window can hold. That
    restart is taken whatever its compile would do, as on 0.28.0, so one
    that can't fit refuses, and the turn ends with an `over_budget` failure
    row.
  - **The preview can't count the rows the restart's start then stores,**
    such as new or changed afterUser injections, so a restart whose preview
    leaves less room than those rows take can still be refused, and the
    turn then ends with its failure row.
  - **Unchanged:** a restart whose preview fits, the `physicalWindowTokens`
    restart, and a strategy with no preview (such as `PassthroughStrategy`),
    which restarts as before.

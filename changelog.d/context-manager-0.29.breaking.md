- **Hosts:** agent-framework now depends on `@animalabs/context-manager`
  `^0.29.0` (was `^0.28.0`), and accepts `@animalabs/chronicle`
  `^0.6.0 || ^0.7.0 || ^0.8.0` (was `^0.6.0 || ^0.7.0`), the range that
  context-manager 0.29.0 declares. So an install beside a host's own chronicle
  0.8.0 holds that one chronicle. Before, it nested a 0.7 under
  agent-framework and context-manager.
  - **Who needs to act:** a host that depends on context-manager itself; a
    host that previews a context, reads one through the API, runs a gate reply
    judge or spawns conversation forks, under the autobiographical strategy; a
    host that subclasses `AutobiographicalStrategy`; and a host with no
    chronicle of its own, or one whose framework opens its store by path.
  - **Migration:** take context-manager `^0.29.0` too. Beside a 0.28.x of its
    own, an install holds two copies of context-manager. Then a check of a
    class fails for what the other copy made. The framework refuses a
    `PassthroughStrategy` with `subconscious.reader: 'forks'` and no
    `strategyFactory`. And `previewContextSettings` throws for a non-adaptive
    `AutobiographicalStrategy` whose select fits the budget, where it would
    give null. A host that declares chronicle may stay on 0.6 or 0.7, or move
    to 0.8. A lockfile's 0.6 or 0.7 is still admitted. A caller of
    `previewActivation` in the same process catches context-manager's
    `OverBudgetError`, by its class or, across two copies, by
    `error.name === 'OverBudgetError'`, or asks `previewContextSettings`
    whether the agent's budget fits. An API or MCP client gets the refusal's
    message as an error, and `lastVisible` gives null.
  - **When the framework's chronicle becomes 0.8.0:** on a fresh install, a
    host with no chronicle of its own gets 0.8.0, where it got 0.7. Where the
    framework opens the store by its path (`storePath`,
    `agent-framework-recover`), a host on chronicle 0.8.0 whose install shares
    that chronicle now opens it with 0.8.0. Before, the framework used its
    nested 0.7. Where a lockfile keeps that nested 0.7, the framework still
    opens with it. chronicle 0.8.0
    opens and reads a store that 0.6 or 0.7 wrote. On disk it adds only saved
    length checks in `state.bin`, which 0.6 and 0.7 don't read, so they still
    open a store that 0.8.0 wrote. chronicle 0.8.0's breaking changes reach a
    host through this package: an open fsyncs the log before it returns, and
    refuses a used store that has lost its log; a write first retries a failed
    fsync of the log; and a branch call whose checkpoint fails undoes its
    change. This package matches two chronicle messages,
    `State already exists` and the OS error at the end of an `IO error: `
    message, and chronicle 0.8.0 changes neither.
  - **What changes for a preview:** in context-manager 0.29.0, a dry compile
    meets the adaptive plan check that a committing compile meets. So under
    the autobiographical strategy, a preview refuses a fold plan that doesn't
    fit, with `OverBudgetError`. The refusal names the plan's tokens and the
    budget. Before, such a plan passed when the context that it emitted fit.
    These meet that refusal now:
    - `previewActivation`;
    - the API's `message.list` and `agent.context`, and the MCP tools
      `agent_list_messages` and `agent_context`, which answer with the
      refusal's message as an error;
    - the seed of a conversation fork from its template, so the fork isn't
      made;
    - a gate's reply judge, which counts it as a failure of the judge and then
      acts as its `onError` says;
    - the preview after `hide`, `undo`, `rollbackToMessage` and
      `suppressMessages`, which then gives `lastVisible` as null;
    - `previewContextSettings` with `render`, which on a final refusal gives
      `fits: false` with no `entries` or `stats`.
  - **A refused preview doesn't show that a turn fails:** a turn's compile can
    unpin its inputs, or fall back after a boot, and a preview does neither.
  - **context-manager's other changes that reach a host:** its adaptive
    plan-check refusal now opens with `Adaptive plan check (`, where it said
    "Adaptive picker exhausted" or "still exceed". `AutobiographicalStrategy`,
    which this package exports, reserves two protected hook names,
    `getCompressionOpening` and `getSourceMergeInstruction`. context-manager's
    changelog for 0.29.0 lists the rest.

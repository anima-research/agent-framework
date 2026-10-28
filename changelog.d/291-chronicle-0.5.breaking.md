- **Hosts and packages that install agent-framework:** it now depends on `@animalabs/chronicle` `^0.5.0` (was
  `^0.4.0`) and `@animalabs/context-manager` `^0.24.0` (was `^0.23.1`): the chronicle release that carries the
  identity-stamped batched append (`appendManyToStateJsonWithIdentity`), and the context-manager release that keeps
  each agent's window (`windowStatusOf`, `presentRows`, `retractRows`, `getPresentedMessages`) and writes a window
  write as one record with it (context-manager's 291-chronicle-0.5 and 291-window-batches entries). The range starts
  at 0.24.0, not 0.23.1: context-manager 0.23.0 and 0.23.1 were published without the window APIs, so `^0.23.1`
  would install 0.23.1, and `AgentFramework.create()` refuses a context-manager without `presentRows`. 0.24.0
  carries 0.23.1's changes, so what 0.29.0's entry for `^0.23.1` says of the runtime-settings preview holds under it
  too. Every agent's window is written down
  at its registration (#291), and without the batched form context-manager writes it one record per row: about 23
  seconds and 63 MB of log for a 200,000-row namespace, against a quarter of a second as one record, on one synthetic
  store, and a presentation of several rows that fails partway leaves the rows before it presented. The new ranges
  make that gate mechanical: an install either gets the batched append and the window APIs or doesn't resolve. Until
  chronicle 0.5.0 and context-manager 0.24.0 are published, an install of this release doesn't resolve.
  **Who needs to act:** a host that depends on chronicle or context-manager itself, such as connectome-host, which
  takes the matching ranges alongside this release so that npm installs one copy of each.
  **Migration:** take `@animalabs/chronicle` `^0.5.0` and `@animalabs/context-manager` `^0.24.0` alongside this
  release. A store chronicle 0.5 writes a batch to moves to `MANIFEST` version 2, which older chronicle releases
  refuse (see the 291-presentation-mandatory entry).
  **Unchanged:** a store handle without the batched form (one a host opened from its own older chronicle, passed as
  `FrameworkConfig.store`) still works, one record per row, and `create()` says so once, before any window is
  written down: a `console.warn` line and an `ops:alert` of kind `chronicle-per-row-window-writes`, which name the
  chronicle agent-framework loads and the cost.

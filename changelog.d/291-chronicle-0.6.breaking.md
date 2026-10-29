- **Hosts and packages that install agent-framework:** it now depends on `@animalabs/chronicle` `^0.6.0` (was
  `^0.5.0`) and `@animalabs/context-manager` `^0.25.0` (was `^0.24.0`): the chronicle release with the
  identity-stamped batched append (`appendManyToStateJsonWithIdentity`, with `appendManyToStateJson`,
  `getStateItemsJson` and `getRecords`), and the context-manager release that keeps each agent's window
  (`windowStatusOf`, `presentRows`, `retractRows`, `getPresentedMessages`) and writes a window write of several rows
  as one record through that append (context-manager's 291-chronicle-0.6 and 291-window-batches entries). Neither
  floor can be lower. The published chronicle 0.5.0 (0.30.0's branch views) has none of the batched calls, and the
  published context-manager 0.23.x and 0.24.0 have no window index. Context-manager has no one-record-per-row path:
  on a store handle without the batched append, the first window write-down of a record that holds a row throws, and
  every agent's window is written down at its registration (#291). So `AgentFramework.create()` refuses, before any
  agent is registered, a store handle without `appendManyToStateJsonWithIdentity` and a context-manager without
  `ContextManager.presentRows`, each with an error that names the range this package declares. chronicle 0.6.0 and
  context-manager 0.25.0 carry 0.5.0's and 0.24.0's changes, so what 0.30.0's entry says of derived agents and
  branch views holds under them too. Until chronicle 0.6.0 and context-manager 0.25.0 are published, an install of
  this release doesn't resolve.
  **Who needs to act:** a host that depends on chronicle or context-manager itself, such as connectome-host, which
  takes the same ranges alongside this release so that npm installs one copy of each; and a host that opens its own
  `JsStore` and passes it as `FrameworkConfig.store`, whose handle must come from chronicle 0.6.0 or later.
  **Migration:** take `@animalabs/chronicle` `^0.6.0` and `@animalabs/context-manager` `^0.25.0` alongside this
  release. The first window write-down that holds a row, or any presentation of more than one row, moves the store's
  `MANIFEST` to version 2, which chronicle 0.5.0 and earlier refuse (see the 291-presentation-mandatory entry).

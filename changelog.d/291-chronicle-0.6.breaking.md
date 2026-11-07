- **Hosts and packages that install agent-framework:** it now depends on `@animalabs/chronicle` `^0.6.0` (was
  `^0.5.1`) and `@animalabs/context-manager` `^0.25.0` (was `^0.24.0`): the chronicle release with the
  identity-stamped batched append (`appendManyToStateJsonWithIdentity`, with `appendManyToStateJson`,
  `getStateItemsJson` and `getRecords`), and the context-manager release that keeps each agent's window
  (`windowStatusOf`, `presentRows`, `retractRows`, `getPresentedMessages`), writes a window write of several rows as
  one record through that append (context-manager 0.25.0's release notes), names the rows of an add that failed after
  storing them (`WriteLandedError`), and says when the store can't be read to tell what of a failed add landed
  (`WriteOutcomeUnknownError`). Neither floor can be lower: chronicle 0.5.1 and earlier have none of the batched
  calls, and context-manager before 0.25.0 has no window index, so `AgentFramework.create()` refuses a store handle
  without `appendManyToStateJsonWithIdentity` before it writes anything to the store, and a context-manager without
  `ContextManager.presentRows` before it opens one, each with an error that names the range this package declares. The
  framework reads context-manager's two errors from its exports as it loads, so on 0.24.0, which has neither, the
  package still loads and `create()` gives that error. chronicle 0.6.0 and context-manager 0.25.0 carry 0.5.0's and
  0.24.0's changes, so what 0.30.0's entry says of derived agents and branch views holds under them too.
  **Who needs to act:** a host that depends on chronicle or context-manager itself, such as connectome-host, which
  takes the same ranges alongside this release so that npm installs one copy of each; and a host that opens its own
  `JsStore` and passes it as `FrameworkConfig.store`, whose handle must come from chronicle 0.6.0 or later.
  **Migration:** take `@animalabs/chronicle` `^0.6.0` and `@animalabs/context-manager` `^0.25.0` alongside this
  release. The first window write-down that holds a row, or any presentation of more than one row, moves the store's
  `MANIFEST` to version 2, which chronicle 0.5.1 and earlier refuse (see Breaking: every agent's context follows its
  own presentation index).

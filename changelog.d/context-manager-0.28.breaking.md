- **Hosts:** agent-framework now depends on `@animalabs/context-manager`
  `^0.28.0` (was `^0.27.0`), and accepts `@animalabs/chronicle`
  `^0.6.0 || ^0.7.0` (was `^0.6.0`), the range context-manager 0.28.0
  declares. So beside a host's own chronicle 0.7.0, an install holds that one
  chronicle, where it nested a 0.6.0 under agent-framework and
  context-manager, and context-manager was handed a store from a chronicle it
  didn't load.
  - **Who needs to act:** a host that depends on context-manager itself.
  - **Migration:** take context-manager `^0.28.0` too: beside a 0.27.x of
    its own, an install holds two copies of context-manager. A host that
    declares chronicle may stay on `^0.6.0` or move to `^0.7.0`; a lockfile's
    0.6.0 is still admitted.
  - **What changes on a fresh install:** a host with no chronicle of its own
    gets 0.7.0, where it got 0.6.0, and opens its existing store with it.
    chronicle 0.7.0 opens and reads a store 0.6.0 wrote. Neither this
    package nor context-manager stores a chunked blob, so a store written on
    0.7.0 still opens on 0.6.0. chronicle 0.7.0 gives its errors its own
    `ErrorCode` as `code`, where they carried napi's `GenericFailure`: this
    package checks no chronicle error's `code` for either value, and reads an
    I/O failure's OS error from its message, which is unchanged.
    context-manager's changelog for 0.28.0 lists its own changes, which
    include that no image is stripped from a window unless a strategy's
    settings ask for it.

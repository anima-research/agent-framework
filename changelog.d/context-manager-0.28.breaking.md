- **Hosts:** agent-framework now depends on `@animalabs/context-manager`
  `^0.28.0` (was `^0.25.1`), and accepts `@animalabs/membrane`
  `^0.8.0 || ^0.9.0 || ^0.10.0` (was `^0.8.0 || ^0.9.0`) and
  `@animalabs/chronicle` `^0.6.0 || ^0.7.0` (was `^0.6.0`), the ranges
  context-manager 0.28.0 declares. So beside a host's own membrane 0.10 or
  chronicle 0.7.0, an install holds that one membrane and that one
  chronicle, where it nested a membrane 0.9.0 and a chronicle 0.6.0 under
  agent-framework and under context-manager, and context-manager was handed
  a store from a chronicle it didn't load.
  - **Who needs to act:** a host that depends on context-manager itself, and
    a host that counted on images being stripped from a window (below). The
    first needs `^0.28.0` too: beside a 0.25.x, 0.26.x or 0.27.x of its own, an
    install holds two copies of context-manager, and a strategy the host
    builds runs its own copy's code and isn't of the framework's classes.
    So a `PassthroughStrategy` of the host's own, with
    `subconscious.reader: 'forks'` and no `subconscious.strategyFactory`, is
    refused where it ran before. A host that declares chronicle may stay on
    `^0.6.0` or move to `^0.7.0`.
  - **What a fresh install gets:** context-manager 0.28.0, membrane 0.10.4
    and chronicle 0.7.0, unless the host's own ranges hold membrane or
    chronicle lower. A lockfile's membrane 0.8.0 or 0.9.0, or chronicle
    0.6.0, is still admitted.
  - **membrane:** requests go out through the membrane the host passes. A
    host that declares membrane sends through its own. One that doesn't
    imports the copy this range installs, so a fresh install moves its
    requests from membrane 0.9.0 to 0.10.4, with the changes membrane's
    changelog for 0.10.0 to 0.10.4 lists.
  - **chronicle:** a host with no chronicle of its own opens its existing
    store with 0.7.0, which opens and reads a store 0.6.0 wrote. Neither
    this package nor context-manager stores a chunked blob, so a store
    written on 0.7.0 still opens on 0.6.0. chronicle 0.7.0 gives its errors
    its own `ErrorCode` as `code`, where they carried napi's
    `GenericFailure`: this package checks no chronicle error's `code` for
    either value, and on POSIX reads an I/O failure's OS error from its
    message, which is unchanged (on Windows it reads none, as before).
  - **context-manager:** its changelog for 0.26.0, 0.27.0 and 0.28.0 lists
    its changes. The framework opens every agent's context manager with its
    own copy, and two of those changes alter what that copy does today.
    Where a later tool call reuses an earlier call's id,
    `stripUnpairedToolBlocks`, which the framework runs on a fork's seed,
    now pairs each result with the nearest call before it with that id, so
    it can drop a call or result it kept. And from 0.28.0 the memory
    strategy and windowed passthrough strip no live image unless their
    settings ask for it (`maxLiveImages`, `imageStripDepthTokens` and
    `maxLiveImageBytes` default to 0, where they were 6, 30000 and 20 MiB).
    Their ceilings are unchanged and still strip (`imageCeiling` 500 images,
    `imageByteCeiling` 24 MiB), so a window's images stay bounded. Of the
    strategies the framework builds itself, this reaches the persistent
    subconscious's window, a windowed passthrough the framework passes no
    image settings: it now keeps its images up to the ceilings. A resident
    with no `strategy` of its own gets `PassthroughStrategy`, which never
    stripped images. A host that passes a memory strategy and wants the old
    limits sets the three options to their old values. 0.26.0's request limit
    and 0.27.0's checks on a system change carrying `effort` apply only
    where a caller passes `requestLimitTokens` or writes `effort`, and the
    framework itself does neither. 0.28.0's `compressionFallbackModel`,
    `carryStrandedSummaries` and kv-unified change costs are off unless a
    strategy sets them.

- **Hosts:** agent-framework now depends on `@animalabs/context-manager`
  `^0.27.0` (was `^0.25.1`), and accepts `@animalabs/membrane`
  `^0.8.0 || ^0.9.0 || ^0.10.0` (was `^0.8.0 || ^0.9.0`), the range
  context-manager 0.27.0 declares. So beside a host's own membrane 0.10,
  an install holds that one membrane, where it nested a 0.9.0 under
  agent-framework and another under context-manager. A host that depends
  on context-manager itself needs `^0.27.0` too: beside a 0.25.x or 0.26.x
  of its own, an install holds two copies of context-manager, and a
  strategy the host builds runs its own copy's code. A fresh install gets
  context-manager 0.27.0 and membrane 0.10.1, unless the host's own range
  holds membrane lower, and a lockfile's membrane 0.8.0 or 0.9.0 is still
  admitted. Requests go out through the membrane the host passes. A host
  that declares membrane sends through its own. One that doesn't imports
  the copy this range installs, so a fresh install moves its requests from
  membrane 0.9.0 to 0.10.1, with the changes membrane's changelog for
  0.10.0 and 0.10.1 lists. context-manager's changelog for 0.26.0 and 0.27.0
  lists its changes. One reaches what agent-framework's own copy does:
  where a later tool call reuses an earlier call's id,
  `stripUnpairedToolBlocks`, which the framework runs on a fork's seed, now
  pairs each result with the nearest call before it with that id, so it can
  drop a call or result it kept.

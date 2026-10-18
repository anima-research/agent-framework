- **Hosts and anyone installing this package:** agent-framework now requires
  Node.js 22.12.0 or later (`engines.node` was `>=20.0.0`). Node 20 reached
  its end of life on April 30, 2026, and Node 22 is the oldest line still
  supported. **Migration:** run on Node 22.12.0 or later; npm warns on an
  older Node, and refuses to install with `engine-strict` set. **Unchanged:**
  the API, the dependency ranges and the build; every dependency this package
  installs already admits Node 22.12.0. CI now tests the floor, 22.12.0
  exactly, the newest Node and, on Linux, Node 24 between them, and its
  installs fail if a dependency stops admitting the Node they run on. A
  release publishes only after it builds and passes its tests on the floor.

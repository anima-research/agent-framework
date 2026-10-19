- On Linux, a workspace mount's watcher no longer re-attaches, rescanning
  the whole mount and running its catch-up pass, when a file or directory
  with the mount root's own name is made, saved over or removed anywhere in
  the mount, as a program a build names after its directory is on every
  build. libuv reports such a rename under the same name as the root's own
  removal, and the watcher took every one for the root's. It now holds its
  root open (see Breaking) and checks whether the root is still the directory
  it holds. Where it can't hold the root, as on macOS and Windows or without
  read permission, such a rename still re-attaches it, as before.
- A workspace mount's watcher whose re-attach fails to close its old chokidar
  instance now reports that and attaches again. It used to stop watching the
  mount until the root's identity changed.

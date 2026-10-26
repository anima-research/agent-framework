- **Hosts:** agent-framework now requires `@animalabs/context-manager`
  ^0.23.0 (was ^0.20.0; 0.23.0 is the release #291 needs, see the
  291-chronicle-0.5 entry). A host whose own context-manager range is still
  below it gets two copies, and a `ContextManager` built from its own copy
  isn't the one agent-framework's types take: connectome-host's `main`,
  with ^0.20.1, fails to typecheck where the two meet, installed with npm
  or bun. context-manager 0.22.0's own breaking change reaches every host
  too: a `maxLiveImages`, `maxLiveImageBytes` or `maxCompressionImageBytes`
  of 0, documented as no limit, now means up to `imageCeiling` (500 images
  by default) or `imageByteCeiling` (24 MiB), and so does a value above its
  ceiling (context-manager's 0.22.0 notes). **Migration:** move the host's
  own context-manager range to ^0.23.0 with this release; with it,
  connectome-host's `main` installs one copy and typechecks.

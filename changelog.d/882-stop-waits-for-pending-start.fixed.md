- **A module's `stop()` no longer begins before its `start()` has settled**
  (#882). A `stop()` of the framework, or a `removeModule()`, made while an
  `addModule()` was still running the module's `start()` used to call the
  module's `stop()` at once, so whatever the rest of its `start()` set up,
  such as its own timers, outlived the stop that should have ended it. Now
  the module's `stop()` is called once its `start()` has settled, within the
  same wait for that module `stop()` already had, so a `start()` that never
  settles spends `stop()`'s budget as a slow `stop()` does, and the module's
  `stop()` then runs when its `start()` settles. That `addModule()` now
  rejects, with the refusal an `addModule()` made during a `stop()` gets, and
  no `module:added` is emitted for the module; before, it resolved and the
  module was announced after the framework had already stopped it.

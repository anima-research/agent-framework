- **A module's `stop()` now waits for its `start()` to settle** (#882). A
  `stop()` of the framework, or a `removeModule()`, made while an
  `addModule()` was still running the module's `start()` used to call the
  module's `stop()` at once, so whatever the rest of its `start()` set up,
  such as its own timers, outlived the stop that should have ended it. Now
  the module's `stop()` is called once its `start()` has settled, fulfilled
  or rejected, including for a `removeModule()` the `start()` itself makes.
  The framework's `stop()` waits for that within its wait on modules, so a
  `start()` that outlasts `stop()`'s budget fails the `stop()` as a slow
  `stop()` does, and the module's `stop()` runs once the `start()` settles;
  if it never settles, the module's `stop()` is never called. A
  `removeModule()` has no budget and waits for the `start()` as long as it
  runs. So a module's `start()` mustn't await its own removal or the
  framework's `stop()`: both now wait for it, where before its `stop()` ran
  beside it. A `removeModule()` made during a `start()` now announces the
  module added, then removed; before, it was announced removed, then added.

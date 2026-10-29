- **A module's `stop()` no longer begins before its `start()` has settled**
  (#882). A `stop()` of the framework, or a `removeModule()`, made while an
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
  framework's `stop()`: both now wait for it.
  Where it was the framework's `stop()` and the `start()` fulfils, that
  `addModule()` now rejects, with the refusal an `addModule()` made during a
  `stop()` gets, and no `module:added` is emitted for the module; before, it
  resolved and the module was announced after the framework had already
  stopped it. A `start()` that rejects rejects the `addModule()` with its own
  error, as before. Where it was a `removeModule()`, the `addModule()`
  resolves, and the module is announced added, then removed; before, it was
  announced removed, then added.

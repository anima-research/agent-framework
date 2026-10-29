- **An `addModule()` whose `start()` is still running when the framework's
  `stop()` is admitted is refused** (#882). Once that `start()` fulfils, the
  `addModule()` rejects, with the refusal an `addModule()` made during a
  `stop()` gets, and no `module:added` is emitted for the module; before, it
  resolved and the module was announced after the framework had already
  stopped it. A `start()` that rejects rejects the `addModule()` with its own
  error, as before.

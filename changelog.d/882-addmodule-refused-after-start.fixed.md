- **An `addModule()` whose `start()` is still running when the framework's
  `stop()` is admitted is refused** (#882). Once that `start()` fulfils, the
  `addModule()` rejects with the refusal an `addModule()` made at that
  moment gets, which follows the stop's state then, and no `module:added` is
  emitted for the module; before, it resolved and the module was announced
  after the framework had already stopped it. A `start()` that rejects
  rejects the `addModule()` with its own error, as before.

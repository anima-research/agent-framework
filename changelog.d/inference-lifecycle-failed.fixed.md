- **An inference whose stream fails now ends its `inference/lifecycle` with
  `failed`, where it ended `completed`.** An MCPL server granted
  `inferenceLifecycle` was told that such an inference completed. Three
  endings change:
  - an `error` event that ends the turn;
  - an `error` event that is retried. The retry is an inference of its own,
    with its own `started` and terminal, and a retry that `stop()` cancels
    leaves the failed inference `failed`;
  - an `aborted` event whose reason isn't `user`, such as `timeout`.

  The endings a stop or the framework's own cancel accounts for still end
  `aborted`, as before: an `aborted` event with reason `user`, an `error`
  event after a caller's stop, and an `aborted` or `error` event after the
  framework's cancel.

- A failure membrane marks retryable (a `MembraneError` with
  `retryable: true`) that a turn stream of another make throws from its
  iterator before its terminal event is held, retried and logged as the same
  failure sent as an `error` event is, as membrane's own streams send it
  (agent-framework#734). In 0.27.0 it ended the turn after one send
  (`inference:failed`, then `inference:exhausted`) without asking the error
  policy. Its inference-log row is now the provider's words, without the
  `Provider acceleration cooldown:` or `Provider wait:` prefix the throw's
  path gave it. The stream that threw is cancelled before the retry.

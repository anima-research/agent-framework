- A failure membrane marks retryable (a `MembraneError` with
  `retryable: true`) that a turn stream of another make throws from its
  iterator before its terminal event is held, retried and logged as the same
  failure sent as an `error` event is, as membrane's own streams send it
  (agent-framework#734). In 0.27.0 such a throw never asked the error policy:
  an organization-acceleration 429 on a turn holding the provider gate, or a
  conversation agent's stated wait, was held, with its inference-log row
  prefixed `Provider acceleration cooldown:` or `Provider wait:`, and any
  other, a 529 among them, ended the turn after one send
  (`inference:failed`, then `inference:exhausted`). Its row is now the
  provider's words, as the event's is. The stream that threw is cancelled
  before the retry.

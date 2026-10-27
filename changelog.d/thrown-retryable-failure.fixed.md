- A failure membrane marks retryable (a `MembraneError` with
  `retryable: true`) that a turn stream of another make throws from its
  iterator before its terminal event is held, retried and logged as the same
  failure sent as an `error` event is, as membrane's own streams send it
  (agent-framework#734). In 0.27.0 such a throw never asked the error policy.
  A turn that owns the provider gate, as a resident's does, was held when the
  host's provider hold claimed the failure, when it was an
  organization-acceleration 429, or when it stated a wait still to come, with
  its inference-log row prefixed `Provider acceleration cooldown:`; a
  conversation agent's was held when it stated such a wait, prefixed
  `Provider wait:`. Any other, a 529 stating no wait among them, ended the
  turn after one send (`inference:failed`, then `inference:exhausted`). Its
  row is now the provider's words, as the event's is. The stream that threw
  is cancelled before the retry.

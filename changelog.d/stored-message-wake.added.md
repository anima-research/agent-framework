- `InferenceRequest.readsStoredMessage` names the stored message that is a
  wake's sole cause, by its row's id, as `readsDeferredWrite` names a held
  write. `WritePlacement` gains `messageId`, the id a message the gate wrote
  was stored under, which a host that builds its own gate passes on with
  `deferredId`.

- `InferenceRequest.readsStoredMessage` names the stored message that is a
  wake's sole cause, by its row's id, as `readsDeferredWrite` names a held
  write. `WritePlacement` gains `messageId`: for a message the gate
  writes, such as its self-wake notice, the `addMessage` hook fills it when
  the message was stored rather than held, as it fills `deferredId` when it
  was held, and the gate passes that placement to `requestInference` as
  `after`.

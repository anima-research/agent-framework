- A wake for a message stored for its agent as it arrived carries
  `InferenceRequest.readsRow` too, the mark of a wake whose sole cause is one
  stored row, by its id (the 291-reads-row entry), as a wake for a row stored
  during the agent's turn does. For a message the gate writes, such as its
  self-wake notice, the `addMessage` hook fills the placement's `messageId`,
  and the gate passes that placement to `requestInference` as `after`.

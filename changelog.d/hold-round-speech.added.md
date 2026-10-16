- `inference:published` and `inference:published_complete` traces carry the
  outgoing stream to in-process consumers: each chunk as it is sent, with
  its `channelId`, `inferenceId`, `index` and `text`, and the `messageId`
  the channel's server returned for that publish, when it returned one;
  and each channel's `complete`. They are emitted whether or not the
  channel's server takes the stream, and carry only what delivery
  published, so a host relay that voices them, such as a TTS bridge, never
  speaks text that `skip_reply`, a send or a private `think` withheld, or a
  publish that failed. `inference:tokens` is unchanged: it carries the
  model's text as it is written, held, as before, while a tool-result
  guard's batch is pending. `mcpl:speech-routed` also reports speech
  publishes, the `sleep` tool's announcement among them, with no stream
  id, index or end, so a relay that voices speech takes one of the two,
  not both, and a relay that edits what it voiced takes the message's id
  from `inference:published`.

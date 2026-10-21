- `inference:published` and `inference:published_complete` traces carry the
  outgoing stream to in-process consumers: each chunk once its publish
  succeeds, with the `serverId` and `channelId` it was published to, its
  `inferenceId`, `index` and `text`, and the `messageId` the channel's
  server returned for that publish, when it returned one; and the
  `complete` for each server's channel it published to. They are emitted
  whether or not the channel's server takes the stream, and carry only what
  delivery published, so a host relay that voices them, such as a TTS
  bridge, never speaks text that
  `skip_reply`, a send or a private `think` withheld, or a publish the
  server didn't confirm. `inference:tokens` is unchanged: it carries the
  model's text as it is written, held, as before, while a tool-result
  guard's batch is pending.
  `mcpl:speech-routed` also reports speech publishes, with no stream id,
  index or end: among them the `sleep` tool's announcement and a
  subconscious's `speak_in_channel`. A relay that voices the agent's prose
  takes the `inference:published` stream, with its
  `inference:published_complete`, and not `mcpl:speech-routed` as well, and
  takes each message's id from `inference:published` to edit what it voiced.

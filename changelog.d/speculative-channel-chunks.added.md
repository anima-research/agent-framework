- Speculative channel chunks (`AgentConfig.speculativeChannelChunks`, default
  off; docs/speculative-channel-chunks.md): while the model writes a
  `channel_publish` call to a channel whose capabilities declare
  `streaming: { speculative: true }`, the call's text streams to that
  channel's server as `channels/outgoing/chunk` deltas, before the publish;
  the publish carries the stream's `streamId`, and its outcome ends the stream
  with `complete` (the full text) or `complete` with `cancelled: true`. Needs a
  membrane with `emitToolInputDeltas` (native tool mode, Anthropic).

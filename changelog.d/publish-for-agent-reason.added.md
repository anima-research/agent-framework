- `ChannelRegistry.publishForAgent`'s failure carries a `reason` when the
  destination refused it before anything went out: `channel-not-registered`,
  `inbound-only`, `server-gone`, `server-connecting`, `server-down` or
  `not-permitted`, the state its words come from, or `not-sent`, where its
  connection refused the request before anything was written. The type is
  exported as `PublishRefusalReason`. A host that matched the words these
  refusals had before this release, such as `Channel not found` or
  `Server not found`, reads `reason` instead. A refusal of the caller's own
  input, and a publish that went out, carry none.

- **Per-channel conversation routing is deprecated** (`FrameworkConfig.conversations`,
  `ConversationRouter`, `ConversationRouterConfig`). Its `'mention'` bind/trigger
  rule, the default for channels, reads `metadata.mentioned`, which discord-mcpl
  never sets, so on Discord channels an @-mention neither binds a fork nor
  triggers a bound one (#235). Behavior is unchanged for now: routing still
  works, and the framework logs one `[deprecated]` line when it is created with
  `conversations` set. Removal is a follow-up. The `idleTtlMs` docs now note
  that expiry is checked at most about once a minute, so short TTLs close up to
  ~60s late.

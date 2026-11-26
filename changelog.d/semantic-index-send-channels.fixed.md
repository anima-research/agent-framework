- The semantic index can now tag a message without channel metadata when
  all text retained by the index's character limit comes from sends to one
  known destination. Recognized Zulip stream sends use `zulip:<to>` as
  written; explicit single-user Zulip DMs and publishes with a Zulip-shaped
  channel ID are also recognized. Items that include ordinary text or
  private prose, or have distinct or unresolved send destinations, remain
  untagged. The tag describes the requested destination, not delivery.
  Semantic search rechecks the current channel tag when returning message
  hits. There is no automatic backfill: ordinary sync only walks forward
  from the message watermark minus the configured overlap (10 minutes by
  default), apart from queued edits or removals. To reindex older history
  on the active branch, configure a fresh semantic index namespace and let
  sync catch up from the beginning.

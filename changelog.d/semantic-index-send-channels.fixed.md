- The semantic index can now tag a message without channel metadata when
  all text retained by the index's character limit comes from sends to one
  known destination. Recognized Zulip stream sends use `zulip:<to>` as
  written; explicit single-user Zulip DMs and canonical Zulip channel
  publishes are also recognized. Items that include ordinary text or
  private prose, or have distinct or unresolved send destinations, remain
  untagged. The tag describes the requested destination, not delivery.
  Existing entries keep their channel until re-synced; there is no
  automatic backfill.

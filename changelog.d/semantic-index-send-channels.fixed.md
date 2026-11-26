- Semantic index messages without channel metadata now get a tag for the
  turn's single send destination, even when the item also indexes ordinary
  text or private-prose tools. This replaces the mixed-prose rule that left
  such items untagged. The tag is a denylist filtering hint, not proof the
  prose was delivered there. Zulip stream sends use `zulip:<to>` as written;
  explicit single-user Zulip DMs and canonical Zulip channel publishes are
  also recognized. Items with no sends or with distinct or unresolved send
  destinations remain untagged. Existing entries keep their channel until
  re-synced; there is no automatic backfill.

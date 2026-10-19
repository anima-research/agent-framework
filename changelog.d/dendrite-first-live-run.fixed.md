- From the first live run of tune-out mk2 (Weft, 2026-10-12): a reader
  fork that ends in prose without `deliver_summary` now has its final prose
  delivered as its report (`tune-out:reader-prose-delivered`) instead of
  losing it to `proseRouting: 'disabled'`; under `speech.locus: 'delivery'`
  an addressed message injected mid-turn from another channel is announced
  (who, from where, where the prose still lands); `tune_out check`'s `peek`
  shows only the epochs holding the channel now, never a released one;
  `stop()` leaves bounded work it cuts off live for the next boot to end as
  `host-restart` and report (`dendrite:agent-interrupted` at stop), and
  create()-time traces replay to a listener that asks (`onTrace(fn, { replay: true })`);
  `channel_publish` without a `channelId` goes to the turn's locus (the
  waking delivery, a channel opened this turn) before being refused.
  `isAddressedMessage` is tag-only and says so; its unread parameter is gone.

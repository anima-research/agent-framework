- **Hosts that read the `channelId` of `inference:tokens` or
  `inference:content_block` traces:** in `locus` and `hybrid` mode it now
  follows the turn's locus. It was documented as "the turn's locus as the
  stream started", so after an addressed re-pin, or the agent's own
  `channel_open`, moved the locus between rounds, it kept naming the old
  channel for the rest of the stream. It now names the new locus from the
  next round on: from the model's first content in that round, or from its
  retry after a refusal. It is still the channel the stream shows typing in,
  and in `hybrid` mode still the locus whether or not a `>>>` envelope sends
  the text elsewhere.
  - **Migration:** a consumer that keeps the first `channelId` it sees for an
    activation, as a voice relay may, works as before, and stays on the old
    channel after a re-pin; to follow the move, read each trace's
    `channelId`. A consumer that groups one stream's chunks by `channelId`
    now finds a stream whose locus moved under two channels.
  - **Unchanged:** `explicit` mode's traces, which name the trigger channel,
    and the live outgoing stream (`channels/outgoing/chunk` and `complete`).

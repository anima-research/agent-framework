- **Visible source headers on channel traffic.** Every channel-bearing item
  from either MCPL lane begins with a header naming the conversation it came
  from: `[source: <server> / <canonical-channel-id> · <label at receipt>]`,
  with ` · thread <id>` and ` · reply to <id>` when the item has them. A push
  that names no channel is marked `[source: <server> · unscoped]` rather than
  given a guessed channel. This covers creates, coalesced deliveries and
  corrections. The header is rendered once at ingestion from the item's own
  frozen source envelope and stored with the message, so a later rename, a
  recompile or a replay never rewrites it, and a message names its channel
  when read alone, even the second of two consecutive messages. Adapter body
  text is unchanged, and console/API input has no header.
- `channel_open` backscroll items each gain a `source` field. It is rendered
  from the item's own `channelId`, so an item spliced in from another channel
  wears its true channel. The label comes from the registry for that id, else
  the adapter's item `channelLabel`.
- The canonical id is authoritative when a label differs. That rule is stated
  in the `channel_list`, `channel_open` and `channel_publish` descriptions,
  and in a one-time `[source]` notice the first time a resident has channel
  traffic.

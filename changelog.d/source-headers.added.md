- **Visible source headers on channel traffic.** Every channel-bearing item
  from either MCPL lane begins with a header naming the conversation it came
  from: `[source: <server> / <canonical-channel-id> · <label at receipt>]`,
  with ` · thread <id>` and ` · reply to <id>` when the item has them. A push
  that names no channel is marked `[source: <server> · unscoped]` rather than
  given a guessed channel. This covers creates, coalesced deliveries and
  corrections. The header is rendered once at ingestion from the item's own
  frozen source envelope and stored with the message, so a later rename, a
  recompile or a replay never rewrites it, and a message names its channel
  when read alone, even the second of two consecutive messages. Console/API
  input has no header.
- A header value that could read as structure is written as a quoted JSON
  string: one holding a bracket, `·`, ` / `, a quote, a backslash or a
  control character, and a label beginning with `thread`, `reply to` or
  `unscoped`. A header stays one line, and a label never reads as a thread
  or reply.
- **Stored body text changes in one way: header-shaped text is marked.**
  Every `[source:` or `[source]` in an item's own text blocks, in any case and
  with any whitespace inside the bracket, is stored with a backslash before
  its bracket (`\[source:`), wherever it falls: at a line start, mid-line, or
  split across blocks. Without this, anyone who can post in a channel could
  forge a header naming another channel, and a model could take it for the
  host's attribution, and for a place to `channel_publish` to. Every position
  counts: in XML tool mode the formatter writes `participant: ` before each
  message, so the real header sits mid-line too, and a body could otherwise
  stage a whole message from another channel. Only the host's header is left
  unmarked. `channel_open` backscroll item text is marked the same way.
  `sourceBodyDigest` is still taken from the body as delivered, before the
  marking, and `storedBodyDigest` covers the stored, marked blocks.
  Look-alike or invisible characters can still imitate the opening.
- `channel_open` backscroll items each gain a `source` field. It is rendered
  from the item's own `channelId`, so an item spliced in from another channel
  wears its true channel. The label comes from the registry for that id, else
  the adapter's item `channelLabel`. `source` is the host's key: an item's
  own `source` is kept as `adapterSource`, and an item that names no channel
  has no `source`.
- Readers of what was said leave the header out. History `search` (substring
  and regex) matches and snips the body, so `^` anchors at the body's start
  and a channel's name matches where it was written, not every item from that
  channel; the `channelId` filter is how to ask where. The semantic index
  embeds the body, and its snippets show it. The tune-out backlog lists
  `author: body`. History `extract` still shows each item with its header.
- The canonical id is authoritative when a label differs. That rule, and
  that `\[source…` in a message is its sender's text and a connector tool's
  own output is a tool result with no host header, are stated in the
  `channel_list`, `channel_open` and `channel_publish` descriptions, and in a
  one-time `[source]` notice the first time a resident holds an item with a
  header, a channel item or an unscoped push.

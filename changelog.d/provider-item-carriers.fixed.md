- A turn's first request now carries the provider-native items stored from
  earlier turns, such as OpenAI's compaction item and Anthropic's
  server-tool blocks (web search and the like). membrane keeps each on an
  exactly empty text block, and the request builder dropped every empty text
  block, so a resident on OpenAI's Responses API with compaction began each
  turn without the compaction the server had given it. membrane's formatters
  decide per provider whether such an item goes out, and none sends it as an
  empty text block.
  - On Anthropic's API, which takes server-tool blocks back in an assistant
    turn, a resident whose turns used server tools now sends those stored
    blocks, such as web-search results, in each later turn's first request,
    so those requests are larger.
  - For a resident whose stored history holds items its wire now sends,
    compaction items on the Responses API or server-tool blocks on Anthropic's
    API, the first request after a host takes this release differs from the
    one before it from the first such item on. It differs too, on every wire,
    for a resident whose history holds a reply carrying such an item, alone or
    beside its text, with no tool call, thinking signature or encrypted
    reasoning, after a silent tick or a `[Continue]`: the item's id now
    identifies the reply, so that prompt is rendered before it, and the
    request differs from there on. The provider's prompt cache matches such a
    request only up to the first difference.
  - An agent whose `foreignRounds` is `'raw'`, and a co-resident's rows
    stored before audience stamps, now send another agent's stored items as
    stored, as the rest of its rows already go. Whether OpenAI accepts a
    compaction item issued in another conversation isn't known.
  - A stored message holding only such items is sent, but the framework
    doesn't count it as a turn: the request's last turn, its count of stored
    injections, a refusal rewind and the shed after inference exhaustion pass
    over it, as before. The Responses API gets its items, except an Anthropic
    server-tool block; Anthropic's API gets an assistant turn's paired
    server-tool blocks, and a lone call in the request's last message; the
    other wires get none.
  - The framework doesn't resume a paused Anthropic turn (`pause_turn`)
    itself. But while a round stored as server-tool blocks alone is newest, a
    request now ends on that round, with no `[Continue]` after it, which is
    the shape Anthropic asks for to resume one; a silent tick's opening
    request still ends on the tick's separator, so its lone call is left
    out. Before, every request left the round out.
  - A tool boundary's note to a context manager that keeps a thinking-binding
    record now names a row holding such an item where the next request
    carries it as the stream sent it, rather than marking it as a difference.

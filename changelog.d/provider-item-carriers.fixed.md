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
  - The first request after a host takes this release differs from the one
    before it for each resident whose stored history holds such items, so
    that request writes the prompt cache afresh, once.
  - An agent whose `foreignRounds` is `'raw'`, and a co-resident's rows
    stored before audience stamps, now send another agent's stored items as
    stored, as the rest of its rows already go. Whether OpenAI accepts a
    compaction item issued in another conversation isn't known.
  - A stored message holding only such items is sent, but the framework
    doesn't count it as a turn: the request's last turn, its count of stored
    injections, a refusal rewind and the shed after inference exhaustion pass
    over it, as before, since every wire but the Responses API leaves it out.
  - A tool boundary's note to a context manager that keeps a thinking-binding
    record now names a row holding such an item where the next request
    carries it as the stream sent it, rather than marking it as a difference.

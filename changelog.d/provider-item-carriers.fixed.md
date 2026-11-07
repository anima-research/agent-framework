- A turn's first request now carries the provider-native items stored from
  earlier turns, such as OpenAI's compaction item and Anthropic's
  server-tool blocks (web search and the like). membrane keeps each on an
  exactly empty text block, and the request builder dropped every empty text
  block, so a resident on OpenAI's Responses API with compaction began each
  turn without the compaction the server had given it. membrane's formatters
  decide per provider whether such an item goes out, and none sends it as an
  empty text block.
  - A stored row holding only such an item now counts as carried: a refusal
    rewind counts it among the turns it sets aside, and the shed after
    inference exhaustion can take it.
  - A tool boundary's note to a context manager that keeps a thinking-binding
    record now names a row holding such an item where the next request
    carries it as the stream sent it, rather than marking it as a difference.

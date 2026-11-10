- A turn's first request now carries the provider-native items stored from
  earlier turns, such as OpenAI's compaction item and Anthropic's server-tool
  blocks (web search and the like). membrane keeps each on an exactly empty
  text block, and the request builder dropped every empty text block, so a
  resident on OpenAI's Responses API with compaction began each turn without
  the compaction the server had given it. membrane's formatters decide per
  provider whether such an item goes out, and none sends it as an empty text
  block.
  - Hosts: context-manager 0.27.0, which this release requires, prices these
    items at nothing, so its estimate of a window holding them misses what the
    request now sends. Calibration's multiplier rises to cover them only up to
    its ceiling, 1.8, and does so by pricing every other row higher. Its
    adaptive ingress joins a long message's text blocks into new pieces, which
    loses an item stored on one, and its message cap leaves an empty text
    block out once the cap is reached, the item with it.
    anima-research/context-manager#462 prices them as the items they're sent
    as, stores a message that carries one whole, and keeps one past the cap.
    Where only one of the two changes is installed, context-manager's
    over-pricing of items that requests still leave out errs toward
    compressing early, and this change's items priced at nothing err toward a
    request larger than the window.
  - On Anthropic's API, which takes server-tool blocks back in an assistant
    turn, a resident whose turns used server tools now sends those stored
    blocks, such as web-search results, in each later turn's first request, so
    those requests are larger.
  - For a resident whose compiled window holds items its wire now sends,
    compaction items on the Responses API or server-tool blocks on Anthropic's
    API, the first request after a host takes this release differs from the
    one before it from the first such item on, and the provider's prompt cache
    matches it only up to there.
  - An agent whose `foreignRounds` is `'raw'`, and a co-resident's rows stored
    before audience stamps, send another participant's rows without their
    stored items, which are another conversation's provider state, and leave
    out a row holding only such items, as earlier releases did.
  - The agent's own stored message holding only such items is sent, but the
    framework doesn't count it as a turn: the request's last turn and its
    count of stored injections pass over it, as before. The Responses API gets
    its items, except an Anthropic server-tool block; Anthropic's API gets an
    assistant turn's paired server-tool blocks, and a lone call in the
    request's last message, but not through membrane's XML formatter in XML
    tool mode; the other wires get none. So where the agent's own such message
    is newest after another participant's turn, no `[Continue]` follows it,
    and a request can now end on it, such as on a compaction item on the
    Responses API. A refusal rewind and the shed after inference exhaustion
    take such a message, where the request carried it, with the turn before
    it, in the same step and counted as that one turn, since its items may be
    what the provider refuses. One with no turn before it that the request
    carried is never shed, and where nothing else is left to shed, the shed's
    log names it as a message requests still send.
  - The framework doesn't resume a paused Anthropic turn (`pause_turn`)
    itself. A round stored as server-tool blocks alone, which every request
    left out before, is now carried but isn't counted as the agent's turn: a
    `[Continue]` follows it only where the turn before it is the agent's own,
    and otherwise a request whose last message it is sends it last, the shape
    Anthropic asks for to resume one. A request can still put something after
    it: a silent tick's opening request, for one, ends on the tick's
    separator, and then a lone call is left out. Anthropic's server-tools
    documentation asks that a request resuming a paused turn include the same
    tools, since the turn can end on a server tool that hasn't run and the API
    returns a validation error if that tool is missing; the framework sends a
    server tool only where the host's `providerParams` carries it.
  - A tool boundary's note to a context manager that keeps a thinking-binding
    record now names a row holding such an item where the next request carries
    it as the stream sent it, rather than marking it as a difference.

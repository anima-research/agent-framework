- Another participant's stored provider-native items, such as an OpenAI
  compaction item or an Anthropic server-tool block, stay out of the requests
  of an agent that is sent other agents' rows as stored (`foreignRounds:
  'raw'`, the mode of every agent that observes no one, which also covers a
  co-resident's rows stored before audience stamps). Such an item is another
  conversation's provider state.
  - A compile left these items out before, and a row holding only them, as it
    still does.
  - A tool boundary handed the turn's stream another participant's row as
    stored, so on OpenAI's Responses API membrane sent its items. It now hands
    the row without them, and nothing for a row holding only them.
  - `AgentConfig.foreignRounds`' doc said `'raw'` sends rows "as stored". It
    now says "as stored but for a provider's stored items, such as a
    compaction item, which are another conversation's state: a row holding
    only those is left out". The subconscious's `foreignRounds` doc adds "A
    provider's stored item, such as a compaction item, is another
    conversation's state and stays out, and a row holding only such items is
    left out."

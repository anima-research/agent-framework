- A refusal rewind's shed, forced by `/unstick` or not, and the inference-failure quarantine's, work on the agent's
  window once it is presented (#291, decision 4): the agent's newest exchange in its window leaves it as an undone
  turn's rows do, and the record keeps it, as the marker has always said. A co-resident's round, a row the agent was
  never shown, a system change, a row a tune-out holds from residents and another agent's stored injection are no
  longer shed, and no other agent's window, cache prefix or signed thinking changes. An undone row is in no list a
  presentation point presents from, so a later start, a restart or a redo of another turn doesn't bring it back; it
  reads `'undone'` (`windowStatusOf`) and is marked so in the history tools. On a window that is still the record
  the shed removes the rows from it, as before.
- For an agent's call, the history tools (`extract`, `search`, `semantic_search`) leave out another agent's own rows
  (its rounds, its notes, its stored context injections, a puppeted call) that the caller isn't shown, unless the
  caller observes that agent (#291, decision 1: seeing another agent's thread is a declared relationship), and count
  them as `leftOut`. A row the caller is shown is one its window holds and its view keeps: another agent's stored
  injection, or a row a tune-out holds, in a resident's window written down from the shared record is never in its
  requests, so the injection is left out and the held row is marked `not-shown`. A stored injection from before the
  audience stamp counts as the own row of the agent its mark names. An `extract` around a row left out answers that
  no message has its id. A call no agent made stays record-wide, and so does the bound agent's own.
- The summaries the history module reads fold the context it is bound to, its agent's own rounds and notes among
  them, so for another agent's call that doesn't observe that agent (#291, decision 1) they are left out, for now:
  `overview` returns each summarized span with its time, level and counts and without its text (`content: null`,
  `contentLeftOut: true`, counted in `summariesLeftOut`), and `semantic_search` leaves out summary hits, counted in
  `index.leftOut`. A search of summaries alone for such a caller isn't searched again deeper. An agent's call where
  the framework can't say whose context the module is bound to (no `ModuleContext.agentNameOf`, or a context that is
  no live agent's) leaves them out too. Serving such a caller its own context's summaries is later work.
- The host command's message-granular undo (`messages: n`) and offline recovery's count mode count back in the
  agent's window once it is presented, whose order isn't the record's, over the rows of the agent's own slot: a row
  of a slot the agent observes, such as a residents' row in a persistent subconscious's window, isn't counted, since
  a rollback finds its target in the agent's own slot. A rollback to such a row is refused (`unknown-message`) as in
  a slot the agent observes, not as off the active branch.

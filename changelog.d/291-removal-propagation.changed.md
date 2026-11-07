- A refusal rewind's shed, forced by `/unstick` or not, and the inference-failure quarantine's work on the agent's
  window once it is presented (#291): the agent's newest exchange in its window leaves it as an undone turn's rows do,
  and the record keeps it. A co-resident's round the agent doesn't observe, a row it was never shown, a system change,
  a held row and another agent's stored injection aren't shed, and no other agent's window, cache prefix or signed
  thinking changes. In 0.32.0 the shed took the newest exchange from the record, a co-resident's round included, and
  the quarantine's also a row the agent was never shown or one a tune-out held; neither took a row marked `system`,
  such as another agent's stored injection. An undone row stays out across later starts, a restart or a redo of
  another turn, reads `'undone'` (`windowStatusOf`) and is marked so in the history tools. On a window that is still
  the record the shed removes the rows from it, as before.
- For an agent's call, the history tools (`extract`, `search`, `semantic_search`) leave out another agent's own rows
  (its rounds, its notes, its stored context injections, a puppeted call) that the caller isn't shown, unless the
  caller observes that agent (`AgentConfig.observes`), and count them as `leftOut`, each once across a chain of
  resumes (`search` stopped at its `limit` counts those up to its last scanned candidate). A row a resident's window
  holds but its view leaves out (another agent's stored injection, a held row) isn't shown: the injection is left out,
  the held row marked `not-shown`. A stored injection from before the audience stamp is the own row of the agent its
  mark names. An `extract` around a row left out answers that no message has its id. A call no agent made stays
  record-wide, and so does the bound agent's own.
- For another agent's call that doesn't observe the agent the history module is bound to, the summaries it reads are
  left out for now, since they fold that agent's own rounds and notes: `overview` returns each summarized span with
  its time, level and counts but without its text (`content: null`, `contentLeftOut: true`, counted in
  `summariesLeftOut`), and `semantic_search` leaves out summary hits, counted in `index.leftOut`. So does an agent's
  call where the framework can't say whose context the module is bound to (no `ModuleContext.agentNameOf`, or no live
  agent's).
- The host command's message-granular undo (`messages: n`) and offline recovery's count mode count back in the agent's
  presented window, over the rows of its own slot: a row of a slot it observes (a residents' row in a persistent
  subconscious's window) isn't counted, and a rollback to such a row is refused (`unknown-message`) as in a slot it
  observes, not as off the active branch.

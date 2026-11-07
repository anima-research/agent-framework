- An undo of a turn an earlier release recorded (`undoLastTurn`) takes the agent's own framework notices out of its
  window as undone (#291): a drafts notice (`kind: 'prose-drafts'`) or a delivery receipt naming drafts, by
  `draftOwner`; an `[auto-continue]` row, by `agentName`; and a stored context injection, by its mark's `agent`.
  That release stored them with no audience stamp (the notices under `user`, an injection under
  `system_context:<namespace>`), so the undo tells them by that metadata: taken out as arrivals, they would come back
  at the agent's next presentation point, and the drafts scan that decides whether a draft notice is due would still
  count the notice as naming its drafts. A notice that names another agent, or none (such as a `workspace-head-move`
  notice, whose metadata names no agent), is taken out as an arrival.

- An undo of a turn an earlier release recorded (`undoLastTurn`) takes the agent's own framework notices out of its
  window as undone (#291): a drafts notice (`kind: 'prose-drafts'`) or a delivery receipt naming drafts, by
  `draftOwner`; an `[auto-continue]` row, by `agentName`; and a stored context injection, by its mark's `agent`.
  That release stored them under `user` with no audience stamp, so the undo read them as arrivals and took them out
  as such: the agent's next presentation point brought them back, and the drafts scan that decides whether a draft
  notice is due still counted the notice as naming its drafts. A notice that names another agent, or none (such as
  a `workspace-head-move` notice, whose metadata names no agent), is still taken out as an arrival.

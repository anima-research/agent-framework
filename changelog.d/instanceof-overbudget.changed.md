- `classifyInferenceError` matches context-manager's `OverBudgetError` /
  `UncoveredDropError` with a real cross-package `instanceof` now that CM
  exports them from its package root (context-manager#41/#71 — the follow-up
  promised there). The `err.name` comparison is kept as a fallback for
  deployments carrying two CM copies, and the message-prose match remains a
  last resort for serialized reasons; neither classification changes.

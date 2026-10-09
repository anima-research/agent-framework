- A fork made from inside a tool call now sees the call that made it: by default
  `deriveAgent` reproduces the parent's in-flight tool round on the child's
  branch — the pending assistant turn verbatim, then a tool-result message with
  the results already received, a note (or `pendingRound.madeBy.result`) for the
  call that derived the child, and a note for any call still running — so the
  child never meets a dangling `tool_use`. `pendingRound: { include: false }`
  leaves it out.

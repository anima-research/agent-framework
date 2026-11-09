- **Placing a context injection at `beforeUser` is deprecated** (#171),
  from a module's `gatherContext()` and from an MCPL server's
  `context/beforeInference` alike. It's placed again at every compile before
  the newest user message, or at the window's end where there is none, so it
  moves whenever that place does: the request misses the cache from there
  on, and it can split a tool call from its result. Use `afterUser`, which
  is stored where it lands, unless a module sets `placedEachCompile` on it.
  Nothing changes in how injections are applied; the framework logs a
  `[deprecated]` line once for each module or MCPL server that places a
  `beforeUser` injection. `system` and `afterUser` stay supported. A change
  to a `system` injection's text misses the cache from the system prompt on,
  and the conversation doesn't store it. An `afterUser` injection a module
  sets `placedEachCompile` on moves at each start, with the same cache cost
  as `beforeUser`, and on a model that binds a reply's thinking to
  everything before it, every reply after its old place loses its thinking.

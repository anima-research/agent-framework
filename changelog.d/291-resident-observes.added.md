- `AgentConfig.observes`: the other configured agents whose own rows an agent's window takes (#291, decision 1).
  Residents share one slot, and each is shown only its own rows and the rows meant for it, so a resident never saw
  another's rounds, replies, tool results or notes, and though the history tools and these entries call seeing
  another agent's thread a declared relationship, a resident had no way to declare one. Each name is an observe edge
  on that agent in the resident's registry record (`{ agent: 'nova' }`, the path the subconscious's edge takes), and
  the presentation index presents that agent's own rows to it at its points, as any arrival; the history tools
  leave them in for its calls. Rows that agent stored before the edge was declared enter at the observer's next
  point too, all at once, after what its window holds. Only own rows: mail and channel traffic meant for that agent, and its stored context
  injections, stay out, and so do a third resident's rows. One way: `mira` observing `nova` shows mira nova's rows,
  not nova mira's. None by default, so nothing changes unless it is set. `create()` refuses a name that is the
  agent's own or no configured agent's, and anything but a list of names. The rounds an agent observes go out in its
  requests as `AgentConfig.foreignRounds` says, as the persistent subconscious's do: `'transcript'` (the default) or
  `'raw'`. `AgentRegistry.register` takes `declaredWith`, the names declared with the agent, so an edge may name a
  resident registered after it, and two may observe each other; `residentSpec` takes `observes`.

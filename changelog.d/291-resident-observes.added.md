- `AgentConfig.observes`: the other configured agents whose own rows an agent's window takes (#291, decision 1).
  Residents share one slot, and each is now shown only its own rows and the rows meant for it, where 0.32.0 showed each the others' rounds, replies, tool results and notes (see Breaking: every agent's context follows its own presentation index). The history tools and these entries call seeing another agent's thread a declared relationship; this is
  how a resident declares one. Each name is an observe edge
  on that agent in the resident's registry record (`{ agent: 'nova' }`, the path the subconscious's edge takes), and
  the presentation index presents that agent's own rows to it at its points, as any arrival; the history tools
  leave them in for its calls. Rows that agent stored before the edge was declared enter at the observer's next
  point too, all at once, after what its window holds. Only own rows: mail and channel traffic meant for that agent, and its stored context
  injections, stay out, and so do a third resident's rows. One way: `mira` observing `nova` shows mira nova's rows,
  not nova mira's. None by default: a resident with none is shown no other resident's own rows stored since the upgrade.
  `create()` refuses a name that is the
  agent's own or no configured agent's, and anything but a list of names. The rounds an agent observes go out in its
  requests as `AgentConfig.foreignRounds` says, as the persistent subconscious's do: `'transcript'` (the default) or `'raw'`. An agent whose window is still the record (its write-down failed) is sent them `'raw'` until a branch move presents its window; an agent derived from one sent transcripts (`deriveAgent`, shared or copy), and a conversation fork of such a template, are sent them as it is. `AgentRegistry.register` takes `declaredWith`, the names declared with the agent, so an edge may name a
  resident registered after it, and two may observe each other; `residentSpec` takes `observes`.

- An agent can keep its requests' head fixed and declare later changes in its
  context: with `toolDeclarations: 'entries'`, each request carries the
  agent's recorded tools and system text, and each later change to its tools,
  or addition to its system text, is stored as a `system_change` message where
  it took effect, so it no longer rewrites the provider's cache from the head.
  A replacement of system text, and a consolidation once the changes reach a
  tenth of the last response's input, move the head to what's current. A
  request carrying a change that ends with a 400, or with a refusal membrane
  recognises, whatever caused it, goes again on the agent's current head,
  which it keeps to until it's built again. A consolidation waits for a
  compile that already rewrites
  the changes, which `thinkingBinding.binds` (default `true`) narrows for
  models that bind their thinking; past a fifth of the input, or when a
  compile is refused over budget with changes kept, it happens anyway,
  raising an operator line (`head-consolidated`). The default,
  `'head'`, sends requests as before, leaving any system changes out. New
  trace events: `head:declared`, `head:moved` and `head:resend`.
- A host can fork an ephemeral agent onto its parent's head:
  `createEphemeralAgent(config, { headFrom })` starts the new agent with a
  copy of the named running agent's recorded head, and `systemChangeMetadata`
  (exported beside `isSystemChangeMessage`) stamps the system changes copied
  into it as its own, so it reads the parent's cache and declares only its
  own difference. That pays for a fork with its parent's system text; a
  subagent with its own system prompt moves to its own head at its first
  request, as without it.

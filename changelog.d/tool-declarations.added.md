- An agent can keep its requests' head fixed and declare later changes in its
  context: with `toolDeclarations: 'entries'`, each request carries the
  agent's recorded tools and system text, and each later change to its tools,
  or addition to its system text, is stored as a `system_change` message where
  it took effect, so it no longer rewrites the provider's cache from the head.
  A replacement of system text, a consolidation once the changes reach a tenth
  of the last response's input, and a provider's refusal of a change move the
  head to what's current; after a refusal the agent keeps to its head until
  it's built again. A consolidation waits for a compile that already rewrites
  the changes, which `thinkingBinding.binds` (default `true`) narrows for
  models that bind their thinking; past a fifth of the input, or when a
  compile is refused over budget with changes kept, it happens anyway,
  raising an operator line (`head-consolidated`). The default,
  `'head'`, sends requests as before, leaving any system changes out. New
  trace events: `head:declared`, `head:moved` and `head:resend`.

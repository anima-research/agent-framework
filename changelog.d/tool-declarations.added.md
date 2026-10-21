- An agent can keep its requests' head fixed and declare later changes in its
  context: with `toolDeclarations: 'entries'`, each request carries the
  agent's recorded tools and system text, and each later change to its tools,
  or addition to its system text, is stored as a `system_change` message where
  it took effect, so it no longer rewrites the provider's cache from the head.
  A replacement of system text, a consolidation once the changes reach a tenth
  of the last response's input, and a provider's refusal of a change move the
  head to what's current; after a refusal the agent keeps to its head until
  it's built again. `thinkingBinding.binds` (default `true`) narrows
  consolidation and the resend for models that bind their thinking. The
  default, `'head'`, sends requests as before, leaving any system changes out.
  New trace events: `head:declared`, `head:moved` and `head:resend`.

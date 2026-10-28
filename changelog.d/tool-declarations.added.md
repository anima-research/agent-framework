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
  the changes, which `thinkingBinding.binds` narrows for a model that binds
  its thinking: left out, it counts as one here, and only `false` says it
  doesn't (what relies on the declaration, the context manager's record,
  takes `true` alone). Under `'entries'`, the digests a compile with
  `binds: true` is told are the recorded head's, so a declared change keeps
  them, and a move of the head changes them wherever it changes what the
  request carries ahead of its messages. Past a fifth of the input, or when a
  compile is refused over budget with changes kept, it happens anyway,
  raising an operator line (`head-consolidated`). The default,
  `'head'`, sends requests as before, leaving any system changes out. New
  trace events: `head:declared`, `head:moved` and `head:resend`.
- A host can fork an ephemeral agent onto its parent's head:
  `createEphemeralAgent(config, { headFrom })` starts the new agent with the
  named running agent's recorded head, and `systemChangeMetadata`
  (exported beside `isSystemChangeMessage`) stamps the system changes copied
  into it as its own, so it reads the parent's cache and declares only its
  own difference. That pays for a fork with its parent's system text; a
  subagent with its own system prompt moves to its own head at its first
  request, as without it.
- kv-unified's immutable-prefix hash takes an agent's tools as the wire
  carries them, leaving out a field whose value is undefined, as membrane's
  request does, where it wrote such a field as null. A host whose tool
  definitions carry one, built as objects rather than parsed from JSON, gets
  one fresh layout at the upgrade, on `'head'` too.
- A system change row is never a message said to an agent: it restarts no
  re-send count, counts as nothing heard, and moves no turn to a channel,
  whatever its metadata. A row the agent's own view leaves out, such as
  another resident's change, or for the subconscious any change not its own,
  is stored but not injected into its live turn at a tool boundary, and isn't
  noted as said to it or heard; and for an agent on its head, which sends no
  change row, neither is any change row stored at its tool boundary injected.

- An agent can keep its requests' head fixed and declare later changes in its
  context: with `toolDeclarations: 'entries'`, each request carries the
  agent's recorded tools and system text, and each later change to its tools,
  or addition to its system text, is stored as a `system_change` message where
  it took effect, so it no longer rewrites the provider's cache from the head.
  A replacement of system text, which is any edit or removal of a block
  already declared, and a consolidation once the changes reach a tenth of the
  last response's input, move the head to what's current. The blocks' order is
  ignored. So this saves cache writes only while the system blocks already
  declared stay as they are: a block whose text changes on every request moves
  the head on every request. A move stores the new head first, and takes the
  agent's change rows out of its context only once that's stored. A head that
  can't be stored moves nothing: the request goes on the recorded head with
  its changes (with none recorded, on what's current), and a later request
  moves it again. A request carrying a change that ends with a 400 membrane
  doesn't file as `context_length` or `auth`, or with a refusal membrane
  recognises, goes again on the agent's current head, which it keeps to until
  it's built again. Until then it compiles as it's configured, so a host's
  change rows stay in its compile, unsent. A consolidation waits for a compile
  that already rewrites the changes, which `thinkingBinding.binds` narrows for
  a model that binds its thinking: left out, it counts as one here, and only
  `false` says it doesn't (what relies on the declaration, the context
  manager's record, takes `true` alone). Under `'entries'`, the digests a
  compile with `binds: true` is told are the recorded head's, so a declared
  change keeps them, and a move of the head changes them wherever it changes
  what the request carries ahead of its messages. Past a fifth of the input,
  or when a compile is refused over budget with changes kept, it happens
  anyway, raising an operator line (`head-consolidated`). A host's own change
  rows are the host's to remove: the agent neither folds nor removes them. An
  agent built again on `'head'` clears its recorded head at its first request
  and then takes its own change rows out of its context; a record the store
  can't clear keeps them, and a later request tries again. New trace events:
  `head:declared`, `head:moved` and `head:resend`.
- An agent that continues another's context starts on that agent's head:
  `deriveAgent`, and `createEphemeralAgent` with a spec whose `inherit` sets
  no `atSequence` and names a running agent that declares entries, start the
  new agent with that agent's recorded head, read as its creation begins. A
  change the request already carries, whoever's row holds it, isn't declared
  again, so the new agent reads the parent's cache and declares only its own
  difference. `deriveAgent`'s copy stamps the parent's own system changes as
  the child's, and a host that copies the messages itself, once
  `createEphemeralAgent` returns, stamps them with `systemChangeMetadata`
  (exported beside `isSystemChangeMessage`), so they are the new agent's
  own, which a move of its head takes out of its context. That pays for a
  fork with its parent's system text; a subagent with its own system prompt
  moves to its own head at its first request, as without it.
- An agent's own system changes are those stored with the change metadata
  (`systemChangeMetadata`) of its name or one of its `selfParticipants`: its
  compile under `'entries'` keeps them where it leaves out another's, and in
  either mode they're the rows a move of its head takes out of its context (on
  `'head'`, once its recorded head is cleared).
- A subconscious on another model than its resident, as the persistent
  reader or as a reader fork, declares its tools and system text on its
  head, whatever the resident's `toolDeclarations`. A reader fork on the
  resident's own model keeps the resident's setting.

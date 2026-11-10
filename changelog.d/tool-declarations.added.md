- An agent can keep its requests' head fixed and declare later changes in its
  context, where membrane's formatter renders system changes and its adapter
  sends them (`rendersSystemChanges` and `sendsSystemChanges`, as the native
  formatter and the Anthropic adapter declare, and a wrapping adapter must
  declare too): with `toolDeclarations: 'entries'`, each request carries the
  agent's recorded tools and system text, and each later change to its tools,
  or addition to its system text, is stored as a `system_change` message where
  it took effect, so it no longer rewrites the provider's cache from the head.
  A replacement of system text, which is any edit or removal of a block
  already declared, and a consolidation once the changes reach a tenth of the
  request, move the head to what's current. The share is in characters of
  JSON on both sides, of the request as it's sent (another agent's rounds as
  this agent is sent them), leaving out what a provider doesn't price by its
  characters (a base64 source's data, a generated image's, a redacted
  thinking block's, a thinking block's signature and a block's
  provider-native `rawItem`) and what a request on the native formatter
  doesn't send (a parsed block's `rawXml` and `rawXmlImagesAt`, a call's
  `unparseableInput` and a block's `tokenEstimate`), from any object with a
  string `type`, so a tool call's input or a tool's schema holding one beside
  such a `type` counts without it, though it's sent; JSON runs denser than
  prose, so tool changes read as a smaller share than they would in tokens,
  and a move comes somewhat later. The blocks' order is
  ignored. So this saves cache writes only while the system blocks already
  declared stay as they are: a block whose text changes on every request moves
  the head on every request. A move stores the new head first, and takes the
  agent's change rows out of its context once that's stored. A head that
  can't be stored moves nothing while a head is recorded: the request goes on
  the recorded head with its changes, and a later request moves it again.
  With none recorded, the request goes on what's current, the agent's change
  rows taken out of its context and its compile made again, so the compile
  the context manager keeps is the request sent; a removal the store refuses
  then fails the turn. A change row the
  store refuses to write is logged, and the first later request that can
  store a change declares what differs then; one whose write throws though
  the store holds it is declared. A request
  carrying a change that ends with a 400 membrane doesn't file as
  `context_length` or `auth`, or with a refusal membrane recognises, goes
  again on the agent's current head, which it keeps to until it's built
  again, and raises an operator line (`head-resend`). Until then it compiles as it's configured, so a host's
  change rows stay in its compile, unsent. A consolidation waits for a compile
  that already rewrites the changes, which `thinkingBinding.binds` narrows for
  a model that binds its thinking: left out, it counts as one here, and only
  `false` says it doesn't (what relies on the declaration, the context
  manager's record, takes `true` alone). Under `'entries'`, the digests a
  compile with `binds: true` is told are the recorded head's, so a declared
  change keeps them, and a move of the head changes them wherever it changes
  what the request carries ahead of its messages. Past a fifth of the request,
  or when a compile is refused over budget, or for dropping messages no
  summary covers, with changes kept, it happens anyway, raising an operator
  line (`head-consolidated`). A strategy that merges adjacent summaries, as
  context-manager's autobiographical strategy does, doesn't merge two across
  a change row shown between them, so while the agent's own change rows stay
  in place the input grows beyond the rows' own size, until a consolidation
  takes them out and for a while after, as the merges catch up. A host's own
  change rows, stored without the agent's change metadata, are the host's to
  remove: the agent neither folds nor removes them. An
  agent built again on `'head'` clears its recorded head at its first request
  and then takes its own change rows out of its context; a record the store
  can't clear keeps them, and a later request tries again. New trace events:
  `head:declared`, `head:moved` and `head:resend`.
- An agent that continues another's context starts on that agent's head:
  `deriveAgent`, and `createEphemeralAgent` with a spec whose `inherit` sets
  no `atSequence` and names a running agent that declares entries, start the
  new agent with that agent's recorded head, read as its context is taken
  from that agent's (at the shared derive, or at `deriveAgent`'s copy), and
  for a host that copies the messages itself, as its creation begins. A
  conversation fork starts on its template's head, read as its copy of the
  template is taken. An ephemeral agent's head, and a resumed one's, is kept
  in memory per branch: on a branch it has no head for, it adopts its
  current head, where a recorded head is carried into a branch made from
  another. A
  change the request already carries, whoever's row holds it, isn't declared
  again, so the new agent reads the parent's cache and declares only its own
  difference. `deriveAgent`'s copy stamps the parent's own system changes as
  the child's, and a host that copies the messages itself, once
  `createEphemeralAgent` returns, stamps them with `systemChangeMetadata`
  (exported beside `isSystemChangeMessage`), so they are the new agent's
  own, which a move of its head takes out of its context. That pays for a
  fork with its parent's system text that declares entries itself; a new
  agent on `'head'` sends its current head whatever it was started on, and a
  subagent with its own system prompt moves to its own head at its first
  request, as without it.
- An agent's own system changes are those stored with the change metadata
  (`systemChangeMetadata`) of its name or one of its `selfParticipants`, and
  for an agent that shares another's context on a branch of its own, those
  its source counts as its own, since under `'entries'` its view keeps them
  and its requests carry them. Its compile under `'entries'` keeps them
  where it leaves out another's, it folds them onto its head to find what it
  declares, prices them for consolidation, and they're the rows a move of
  its head takes out of its own branch. On `'head'` they're taken out when
  a recorded head is cleared or its compile holds them, and an agent with
  neither, such as a derived agent started on `'head'` at a checkpoint,
  leaves them in place. Where its compile leaves them out, as the
  framework's does on `'head'` for every agent but the subconscious, a
  compile refused over budget takes none of them. A shared child
  `deriveAgent` makes already counts its parent's, since its parent is
  among its `selfParticipants`; a host's shared child, whose
  `selfParticipants` needn't name its parent, counts them through the owners
  the framework gives it as it's created or resumed.
- A subconscious on another model than its resident, as the persistent
  reader or as a reader fork, declares its tools and system text on its
  head, whatever the resident's `toolDeclarations`. A reader fork on the
  resident's own model keeps the resident's setting.

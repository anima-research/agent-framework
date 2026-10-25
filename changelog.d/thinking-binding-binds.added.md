- `thinkingBinding.binds` in an agent's config says the agent's model binds
  its signed thinking to the conversation before it. context-manager 0.22.0
  keeps a record of what each branch sent
  (anima-research/context-manager#155), so that thinking can then be left out
  once its earlier conversation changes, rather than sent and refused or
  dropped. It's off by default.
  - **What compiles are told:** each compile the agent sends, a framework
    turn's, `previewActivation`'s and the direct API's, gets
    `thinkingBinding` (`binds`, `dropBlock`, and the agent's name as
    `participant`) and `identity`, digests of the request's system text,
    tools, model and the rest of what it carries ahead of its messages.
    `previewContextSettings` passes the binding too.
  - **What streams note:** at each tool boundary and at its end, a framework
    stream tells the context manager which stored rows its requests carried
    as stored (`noteRequestSent`), naming the compile it was built from, so
    their thinking is kept at the next compile. The direct API
    (`runInference`) notes nothing, so with `binds` set, each direct-API
    reply's thinking is left out at the compile after it's stored.
  - **No budget restart mid-turn:** with `physicalWindowTokens` set as well,
    `maxStreamTokens` no longer starts a new stream at a tool boundary, since
    the new stream's compile can take the turn's earlier reasoning out of the
    request. The window check still does, whatever the context manager.
  - **An ops alert:** with `dropBlock` set too, where a compile reports where
    the branch's record began (`thinkingRecordedAfter`), a block the provider
    drops that the record doesn't account for raises `thinking-binding-loss`,
    once per agent per incident and again if a call drops more. A reply stored
    before the record began, or a drop for the account's binding (its
    organization or end user), doesn't count. The provider reports drops only
    on a request that carries the drop control.
- `Agent.addAssistantResponse` returns the stored message's id.
  `runInference()`'s doc says that with `binds` set, its compile writes the
  context manager's record, so it's for a time when none of the agent's
  requests is streaming: a stream open meanwhile then has its later notes
  write nothing. `compileContext()` isn't told the binding, and touches no
  record.

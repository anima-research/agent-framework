- A resident is told when reasoning that nothing in its window shows leaves
  its context, in a `[reasoning] <agent>:` line
  (anima-research/context-manager#155). The line is stored as a system notice
  of kind `reasoning-loss`, through `addMessage` with the agent as its target,
  so while a turn is alive it waits for the agent's next boundary, as the
  framework's other notices do.
  - **What's told:** with `thinkingBinding.binds` set, a committing compile's
    strip that begins at a change of the request's head, naming the tools,
    system text or model that changed, or at a branch's first compile, and a
    fold or other change to an earlier message that takes a reply of the
    current turn; a strip counts each stored reply once per agent and branch.
    With `dropBlock` set, blocks the provider dropped that can be placed as
    stored replies or the stream's own rounds, told once per incident and
    again when a call drops more.
  - **What isn't:** a compile before the agent's first framework stream, so
    an agent driven only through the direct `Agent` API is never told; a fold
    between turns; any other change to an earlier message between turns; and
    a call none of whose dropped blocks can be placed, which is the
    `thinking-binding-loss` ops alert's to report, by its own rules.
  - `Agent.onThinkingStrip` is a host's hook, called with each committing
    compile's `thinkingStrip` (never a dry run's) and the key of the branch it
    read. The framework sets it at the agent's first stream unless a host has
    set one; a host's own observer stands in for the framework's, whose line
    for that agent then isn't told.
  - `StartStreamResult.thinkingBranch` is the key of the branch the stream's
    compile read, and `Agent.branchHead()` gives the current branch's key and
    head.

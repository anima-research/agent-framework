- **An awaited tool call now goes where the agent's own call of the tool
  goes.** The admin puppet (`puppetToolCall`), a host's `executeToolCall`
  and a module's `ModuleContext.callTool` take the routing the turn's
  dispatch takes, in its order. Before, an awaited call of `agent_settings`,
  `save_recent_image`, `read_image`, `fetch_reference`, `gate_status`,
  `event_tags`, `wake_add_rule`, `wake_remove_rule`, `sleep`, `wake`,
  `think`, `journal`, `skip_reply` or `prose_help` reached the module
  registry and failed with "Invalid tool name format", and the puppet stored
  that failure in the agent's window as a call the agent had made. Now,
  for each of these tools the framework has (the gate tools only with an
  event gate, and `think`, `journal` and `skip_reply` only with a channel
  registry, which an MCPL server brings):
  - a call of one with agent origin (the puppet's, and a host's) runs the
    handler the agent's own call runs and gets its answer, except
    `skip_reply`, which ends the turn it's called in, while an awaited
    call isn't made in a turn: a host's call of it gets a refusal
    and does nothing, and the puppet refuses it, by name or through a
    `toolsets--act` that reaches it, before anything runs or is stored, as
    it refuses a tool that isn't on the agent's surface. A `sleep` made off
    a turn posts no announcement, as a script's sleep after its turn
    already doesn't;
  - a module's call of the agent's own tools, `think`, `journal`,
    `skip_reply` and `drafts`, is refused with a reason that says so, and
    does nothing, and a module's call of the others runs for the agent its
    `callerAgentName` names;
  - where the dispatcher would answer one of these calls with a refusal
    (such as a conversation fork's `sleep`), the awaited call gets it
    without `refused`, which `ToolResult.refused` says a programmatic call
    never carries;
  - the puppet's check that a tool is on the agent's surface reads the
    tools the agent may call, so an explicit-prose agent's `prose_help` is
    on it;
  - a `fetch_reference` whose work throws before it answers, such as one
    whose `ref_id` has no text form, now answers with the error, on the
    turn's path too, where before no result came from it;
  - a `save_recent_image` that isn't one of its round's own calls, such as
    a module's from inside its own pending tool call, doesn't wait on that
    round's other calls, which would include the call that made it.

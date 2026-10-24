- `AgentFramework.getRequestCompileStats(request)` gives the render stats of the dry compile that
  built a request `previewActivation` returned: context-manager's `CompileResult.renderStats`, what
  that compile selected, by kind, without the injections merged in after it. So a host can show
  the makeup of an agent's next request without sending one
  (anima-research/connectome-host#425). It's null for a request that is sent, when the agent's
  strategy records no stats, and with context-manager before 0.20.1, whose compiles carry none:
  agent-framework's own range stays `^0.20.0`, so a host that reads the stats moves its
  context-manager to 0.20.1.

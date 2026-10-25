- `AgentFramework.getRequestCompileStats(request)` gives the render stats of the dry compile that
  built a request `previewActivation` returned: context-manager's `CompileResult.renderStats`, what
  that compile selected, by kind, without the injections merged in after it. So a host can show
  the makeup of an agent's next request without sending one
  (anima-research/connectome-host#425). It's null for a request that is sent, and when the
  agent's strategy records no stats.

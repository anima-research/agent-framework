- A graceful framework shutdown (`AgentFramework.stop()`) with an inference
  still streaming records its own provenance before cancelling — the same
  `frameworkCancelledStreams` track that `endTurn`, budget restarts and
  quiesce use — so the stream driver settles the turn as a shutdown: no
  `[turn-interrupted]` marker (nobody stopped the agent; the host went
  away), no `inference:exhausted`, one `inference:aborted` with reason
  `shutdown`, an inference-log terminal, and the agent settled so an
  in-flight `runEphemeralToCompletion` rejects immediately instead of
  waiting out its idle watchdog.

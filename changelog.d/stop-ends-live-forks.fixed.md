- `stop()` now ends each conversation fork that's still live, as a closing
  fork's end does, whatever its stream or turn is doing, as it ends each
  ephemeral run. So a failed reply the fork stored and never read reaches
  the primary instead of being lost at a restart. A restart re-creates no
  fork: the next qualifying message on the fork's channel spawns a new
  generation, and nothing reads the old fork's window again. Each fork
  `stop()` ends emits `mcpl:conversation-disposed`, and its channel
  unbinds, so after a `start()` of the same instance each such fork's
  conversation starts again from the template at its channel's next
  qualifying message, a message still queued for that channel included;
  what a `start()` after a settled `stop()` should do is #315's open
  question.
  The notices `stop()` passes on before the registry forgets its channels
  now name the channel by the label the registry has for it, as other
  notices do, rather than by its bare id. A release postponed later, as a
  run's that `stop()`'s sweep ended can be, still names it by its bare id.
  A crash runs no release, so after one a notice a fork stored unread is
  still lost.
- A failed reply still queued for a fork or a run that ended while the
  host was quiesced is now passed to the primary when `stop()` runs, named
  as the registry knows its channel then, and lands when the host resumes.
  Before, the next boot's flush passed it on. A memory-only queue still
  loses it at exit. Any other write queued for such an agent is still
  dropped, logged.

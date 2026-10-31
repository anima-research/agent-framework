- **Hosts that want an agent told when something is derived from it:** pass
  `dendrite.derivationNotice`. Without one, a derivation (a task-fork, a
  subconscious fork, a conversation fork, a resumption) no longer puts an
  `[Agent lifecycle: … was derived from you …]` line, or its collapsed count
  line, in the source agent's context. Text about an agent's own body or mind
  isn't added by default: a host that wants it says so. The hook is given the
  framework's line as before and returns it, its own text, or `null`. The
  `dendrite:agent-created` trace is emitted either way, and the other
  lifecycle lines (an orphan's offer, work a restart interrupted) are
  unchanged.

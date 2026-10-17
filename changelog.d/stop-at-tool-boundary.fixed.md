- **A stop at a tool boundary stops the turn.** Once a round's last tool
  result was in, and while the framework stored the round (an oversized
  result spilling to the workspace), `Agent.cancelStream()` left the
  turn's stream running and `stop()` and `abortInference()` passed the
  agent over. The boundary then resumed the turn, or restarted it when it
  was over budget. So a host's stop there, such as connectome-host's Esc,
  its web UI's interrupt or a subagent's cancel, was undone, `stop()` let
  the turn run on during shutdown, and the framework's `abortInference()`
  returned `false`. Each now cancels the turn's stream, as it does while
  the round's tools run, and the framework's `abortInference()` returns
  `true`.
  - **What a host sees:** the stop's own terminal event instead of a turn
    that goes on. The stopped round isn't stored, as when a stop comes
    while its tools run: neither its assistant content (its text, any
    thinking and its tool_use) nor its results reach the window. A result
    that spilled keeps its workspace file, which nothing stored names.
    `tool:result_dropped` is emitted once, for the result the boundary was
    handling, as for a result whose turn changed while modules caught up
    with the batch. The round's earlier results go with it, without events
    of their own.
  - **What a reader of the store sees:** a round's assistant row, with its
    tool_use, is stored with its results, after the spill's workspace
    write, rather than before it. While the write runs, neither is in the
    window, so the window never holds the tool_use without its results.

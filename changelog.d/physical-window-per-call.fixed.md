- The physical-window projection (#92) projects from the stream's latest
  provider call that reported a prompt. Membrane's usage event is the stream's
  running total across the tool loop, and the projection added it as the
  prior call's prompt and output, so from the boundary after a stream's
  second call on, an agent with `physicalWindowTokens` set could restart its
  stream even when the next request would have fit. Its physical-window
  restart now comes only when that call's prompt and output, what the stream
  has grown by since that call, the round about to be appended and the
  response reserve together cross the window (`maxStreamTokens` still
  restarts on its own), and the `inference:stream_restarted` trace's
  `inputTokens` for a `physical_window` restart is that projection. The
  growth is the blocks appended since that call and the output of each later
  call that reported no prompt. A call's output of 0 counts as `maxTokens`,
  the bound on it, since a call that ends at a tool boundary always wrote a
  `tool_use`. The projection runs once a call on the stream has reported a
  prompt. `Agent.lastStreamRealInputTokens` holds that call's prompt, which
  is what the provider billed, and `lastStreamOutputTokens` its output;
  `Agent.lastStreamUnreportedTokens` holds the growth since.
  `lastStreamInputTokens` stays the stream's accumulated fresh input, which
  is what `maxStreamTokens` checks.

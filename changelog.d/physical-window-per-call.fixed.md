- The physical-window projection (#92) projects from the stream's latest
  provider call. Membrane's usage event is the stream's running total across
  the tool loop, and the projection added it as the prior call's prompt and
  output. So after a few tool rounds, an agent with `physicalWindowTokens` set
  restarted its stream even when the next request would have fit. Its
  physical-window restart now comes only when the latest call's prompt and
  output, the round about to be appended and the response reserve together
  cross the window (`maxStreamTokens` still restarts on its own). A call whose
  usage reports no prompt keeps the last call's numbers. To match,
  `Agent.lastStreamRealInputTokens` and `lastStreamOutputTokens` hold the latest
  call's numbers. `lastStreamInputTokens` stays the stream's accumulated fresh
  input, which is what `maxStreamTokens` checks.

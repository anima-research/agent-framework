- Opt-in `FrameworkConfig.messageQuietPeriod: { quietMs, maxWaitMs? }`: an
  idle agent's turn waits while message wakes for it keep arriving, so a
  burst (a caption and its attachments, a reply split into several messages)
  starts one turn instead of one per part. The scheduler holds the start
  until `quietMs` have passed since the agent's newest message wake, or
  `maxWaitMs` (default 30 s) since its oldest held one, then starts one turn
  with everything queued, as it merges queued wakes today. Each message's
  own decision stays what the gate gives it: who wakes a sleeping agent,
  where a reply goes, what tune-out and conversation routing see. A batch
  holding any other wake (a timer, an operator, a tool result, a
  continuation or a retry of the agent's turn) starts now; the heartbeat is
  no message wake. (#179, carried by #856.)

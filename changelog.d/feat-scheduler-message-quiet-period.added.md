- Opt-in `FrameworkConfig.messageQuietPeriod: { quietMs, maxWaitMs? }`: an
  idle agent's turn waits while message wakes for it keep arriving, so a
  burst (a caption and its attachments, a reply split into several messages)
  starts one turn instead of one per part. A burst is one channel's message
  wakes (or a channel-less source's), held on its own clock until `quietMs`
  have passed since its newest wake or `maxWaitMs` (default 30 s) since its
  oldest; it then starts a turn with its wakes alone, and other channels'
  bursts wait their own turns, so chatter in one channel neither delays
  another's turn nor takes its reply. Each message's own decision stays what
  the gate gives it: who wakes a sleeping agent, where a reply goes, what
  tune-out and conversation routing see. An ambient burst that another
  burst's turn has read is dropped as read, as on `main`; an addressed one
  keeps its turn. Any other wake (a timer, an operator, a tool result) isn't
  held: it starts now with at most one channel's burst, the others still
  waiting; the heartbeat is no message wake. A backlog past its cap after a
  busy turn starts one turn per channel, oldest first. The hold is traced
  (`quiet-period:held`, `quiet-period:released`). Held wakes are queued
  wakes: a `stop()` within the hold drops them, and the message, stored at
  ingress, waits in context for the next wake. (#179, carried by #856.)

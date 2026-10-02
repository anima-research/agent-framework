- Opt-in gate `messageQuietPeriod: { quietMs, maxWaitMs? }`: MCPL message
  wakes are held until the sender goes quiet (default hard cap 30 s), so a
  caption + attachments or a multi-part message wakes the agent once instead
  of once per part. Agents already inferring are not held. Non-message wakes
  (timers, tool results) are unaffected.

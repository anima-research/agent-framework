- Opt-in gate `messageQuietPeriod: { quietMs, maxWaitMs? }`: a message's
  wake is held until its channel has been quiet for `quietMs` (at most
  `maxWaitMs`, default 30 s, from the channel's first held message), so a
  caption and its attachments, or a reply split into several messages, wake
  the agent once instead of once per part. Messages still enter context at
  arrival; only the wake waits, and no line is written for it. The held wake
  goes as a `debounce` policy's batch does: it carries the burst's route, so
  a held DM's reply goes back to the DM; an agent mid-turn gets it after the
  turn; a quiesced host at resume; an agent asleep when the hold ends gets
  none. Holds are per channel, so chatter in one channel delays no other's.
  The heartbeat, scheduled wakes and tool results are unaffected.

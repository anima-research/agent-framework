- Operator controls for awareness marks:
  - `previewSurgeryMarks(agent, { rollbackTo } | { suppress })` shows what a
    surgery would remove and which messages each scope would mark, per
    channel.
  - `listDiscordAwareness()` lists the journal's batches.
  - `cancelDiscordAwareness(batch)` stops a batch's unsent requests and
    retries, and never removes a reaction. Its receipt counts requests in
    flight or unknown, which may still land.
  - `retractDiscordAwareness(batch | 'all')` queues removal of this bot's
    reaction through each message's configured MCPL route. Its receipt
    discloses earlier adds whose outcome is unknown, which may land after the
    removal.
  - `releaseDiscordAwareness(batch)` queues a held batch.

  Each control is recorded in the operator log. The same controls are
  available as the `host/command` `marks` verb (`action: list | cancel |
  retract | release`, `batchId`) and, with the host stopped, as
  `agent-framework-recover --awareness list|cancel|retract|release`.

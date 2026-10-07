- Operator controls for awareness marks:
  - `previewSurgeryMarks(agent, { rollbackTo } | { suppress })` shows what a
    surgery would remove and which messages each scope would mark, per
    channel.
  - `listDiscordAwareness()` lists the journal's batches and retract
    requests.
  - `cancelDiscordAwareness(batch | retractRequest)` stops all further sends
    and retries of a batch's marks, or of a retract's removals, and never
    removes or undoes anything. Its receipt counts requests in flight or
    unknown, including earlier attempts later answered, which may still land.
  - `retractDiscordAwareness(batch | 'all')` queues removal of this bot's
    reaction, through each message's configured MCPL route, for every
    selected message, whatever history says. It supersedes adds not yet
    sent, and its receipt discloses requests whose outcome is unknown and
    imported history that leaves outcomes unrecorded.
  - `releaseDiscordAwareness(batch)` queues a held batch.

  Each control is recorded in the operator log. The same controls are
  available as the `host/command` `marks` verb (`action: list | cancel |
  retract | release`, `target`) and, with the host stopped, as
  `agent-framework-recover --awareness list|cancel|retract|release`.

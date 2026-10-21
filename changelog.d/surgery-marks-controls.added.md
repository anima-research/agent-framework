- Operator controls for awareness marks, described in the README's
  [Live surgery and Discord awareness marks](README.md#live-surgery-and-discord-awareness-marks):
  - `previewSurgeryMarks(agent, { rollbackTo } | { suppress })` shows what a
    surgery would remove and which messages each scope would mark, per
    channel.
  - `listDiscordAwareness()` lists the ledger's batches and retract
    requests, each with its reactions counted by state.
  - `cancelDiscordAwareness(batch | retractRequest)` stops a batch's marks,
    or a retract's removals, from being sent or sent again, and never removes
    or undoes anything.
  - `retractDiscordAwareness(batch | 'all')` queues removal of this bot's
    reaction, through each message's configured MCPL route, for every
    selected message, whatever was answered before.

  Cancel and retract resolve with their receipts once the ledger holds what
  they did. The same controls are the `host/command` `marks` verb
  (`action: list | cancel | retract`, `target`). Each control that changes
  the ledger is recorded in the operator log, and refuses once `stop()` has
  begun, like every operator entry point.

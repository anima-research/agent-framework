- Operator controls for awareness marks, described in the README's
  [Live surgery and Discord awareness marks](README.md#live-surgery-and-discord-awareness-marks):
  - `previewSurgeryMarks(agent, { rollbackTo } | { suppress })` shows what a
    surgery would remove and which messages each scope would mark, per
    channel.
  - `listDiscordAwareness()` lists the journal's batches and retract
    requests.
  - `cancelDiscordAwareness(batch | retractRequest)` stops all further sends
    and retries of a batch's marks, or of a retract's removals, and never
    removes or undoes anything.
  - `retractDiscordAwareness(batch | 'all')` queues removal of this bot's
    reaction, through each message's configured MCPL route, for every
    selected message, whatever history says.
  - `checkDiscordAwarenessBranchName(name)` refuses (`invalid`) a name for a
    new branch that a suppression with pending removals names as its
    target, since a start on a branch with that name would apply them there.

  The same controls are the `host/command` `marks` verb (`action: list |
  cancel | retract`, `target`) and, with the host stopped,
  `agent-framework-recover --awareness list|cancel|retract`. Each control
  that changes the journal is recorded in the operator log, and refuses
  once `stop()` has begun, like every operator entry point.
- A turn-based `host/command` `undo` that undoes a turn records one
  `undo-turns` entry in the operator log: the requested turns, the marks
  choice (`none` included) and the receipt, beside the per-turn `undo-turn`
  entries.
- `agent-framework-recover` records its acts in the store's operator log
  (`<store>/operator-actions.jsonl`), done or refused, with the OS account
  that ran it: each `--awareness` cancel and retract, and each recovery with
  its marks choice and receipt (kind `recovery`). A list, and a recovery's
  dry run, record nothing. `--dry-run` with `--awareness` is refused: a
  control has no preview.

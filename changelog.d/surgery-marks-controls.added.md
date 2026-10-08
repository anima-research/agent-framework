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
    selected message, whatever history says. As the latest authorization
    for those messages, it stops adds that haven't ended and any an earlier
    choice would request later (a prepared surgery's activation), and
    cancelling it never revives them. Its receipt discloses requests whose
    outcome is unknown and imported history that leaves outcomes
    unrecorded.
  - `releaseDiscordAwareness(batch)` queues a held batch.

  Each control is recorded in the operator log. The same controls are
  available as the `host/command` `marks` verb (`action: list | cancel |
  retract | release`, `target`) and, with the host stopped, as
  `agent-framework-recover --awareness list|cancel|retract|release`.
- A turn-based `host/command` `undo` that undoes a turn records one
  `undo-turns` entry in the operator log: the requested turns, the marks
  choice (`none` included) and the receipt, beside the per-turn `undo-turn`
  entries.
- `agent-framework-recover` records its acts in the store's operator log
  (`<store>/operator-actions.jsonl`), done or refused, with the OS account
  that ran it: each `--awareness` cancel, retract and release, and each
  recovery with its marks choice and receipt (kind `recovery`). A list, and
  a recovery's dry run, record nothing. `--dry-run` with `--awareness` is
  refused: a control has no preview.

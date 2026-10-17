- Awareness marks are one-shot. Switching branches, a redo and restarts no
  longer request marks or removals of their own, and a turn undo requests
  only the marks chosen for it; previously a mark followed the branch, removed
  when the source branch became active and re-added when the recovery branch
  did. An operation is not sent again after three unconfirmed attempts, or
  after a refusal no retry can change, and giving up raises a
  `discord-awareness-delivery` ops alert. The README's
  [Live surgery and Discord awareness marks](README.md#live-surgery-and-discord-awareness-marks)
  describes the journal, its receipts and the order of authorizations.
- A start never activates a surgery's marks. A batch an interrupted surgery
  left is retired at the next start, none of its marks sent; one that had
  marks to apply raises a `discord-awareness-not-scheduled` ops alert that
  names the surgery and the redo that applies them. An interrupted
  suppression's removals are still finished, at the first start on its
  branch, and one whose branch doesn't exist is given up with a
  `discord-awareness-suppression-unfinished` alert. Until a suppression is
  finished or given up, a rollback, a suppression, an offline recovery or
  the API's `branch.create` refuses its branch name, and a switch or a redo
  onto that branch is refused.
- A journal record that certifies a body change (a marks activation, a
  completed suppression, a retired batch, or the batch a `hide` or turn
  `undo` records after its change) is now written only after that change is
  synced to the store. Previously a crash could keep marks active for a
  rollback the store had lost.
- Awareness delivery no longer holds MCPL traffic. Previously every MCPL data
  plane waited at startup, at reconnect, at a tools list change and after each
  surgery until every queued mark had been attempted, which at Discord's pace
  could leave the resident deaf for minutes. Delivery now runs in the
  background, and a route that is not connected keeps its work queued until
  it connects. A journal that cannot be read still stops startup, as does a
  pre-journal ledger that can't be imported: either can hold a suppression
  whose removals a start must finish before the agent's context is served.

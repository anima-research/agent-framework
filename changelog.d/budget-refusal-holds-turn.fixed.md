- A turn whose compile is refused for budget waits for compression and then
  runs, instead of ending (#304). The refusal comes before any provider call,
  for example after an immediate budget decrease. Before, the error policy
  retried it into the same refusal within seconds and ended the turn, and once
  compression had made the context fit, nothing ran it again, so the agent
  stayed silent until its next wake. Now a resident's or a conversation
  agent's turn is held while its context manager has compression pending. It
  runs as one fresh compile once a dry-run compile fits, checked after every
  maintenance pass, every drain kick the hold starts, and every surgery, undo
  and redo. Later wakes join it. The hold never closes the provider gate, so
  compression keeps running. It ends 30 minutes after the refusal that
  started it, or at once when compression has nothing left to do, and the
  turn then fails as a refused compile did, its reason saying how long it was
  held. An ephemeral run, and a refusal with nothing pending, fail as before.
  - **What the agent sees:** the held turn's compile carries a note saying
    why it waited, for that compile alone: "[budget-hold] Your context didn't
    fit its budget (100,201 tokens against 48,568), so this turn waited 7 min
    while compression caught up. It fits now." It's never stored.
  - **What hosts see:** the refused attempt still emits `inference:failed`, as
    a provider hold's does, so a module that brackets typing with it stops
    typing while the turn waits, and the turn's next start emits
    `inference:started` again. The logical turn stays open, so it settles when
    the held turn ends, up to 30 minutes later, rather than as exhausted
    within seconds. New traces `inference:held` and `inference:hold_ended`,
    and `healthSnapshot()` gives each agent's `budgetHold` (or null). The
    `context-refusal` ops alert goes out when the hold starts, and says the
    turn is held until its deadline.

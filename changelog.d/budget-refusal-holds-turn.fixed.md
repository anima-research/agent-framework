- A turn whose compile is refused for budget waits for compression and then
  runs, instead of ending (#304). The refusal comes before any provider call,
  for example after an immediate budget decrease. Before, the error policy
  retried it into the same refusal within seconds and ended the turn, and once
  compression had made the context fit, nothing ran it again, so the agent
  stayed silent until its next wake. Now a resident's or a conversation
  agent's turn is held while its context manager has compression pending.
  Later wakes join it. The hold never closes the provider gate, so
  compression keeps running. An ephemeral run, and a refusal with nothing
  pending, fail as before.
  - **When it runs:** as one fresh compile, once context-manager's preview of
    that compile says it fits. A dry compile can't say so, since it doesn't
    throw an over-budget plan at its plan check. A strategy with no preview
    gets the dry compile. The hold looks after every maintenance pass, every
    drain kick it starts, and every surgery, undo and redo, and again only
    once something that could make the context fit has changed: compression's
    progress, the agent's budget or runtime settings, or the store, by a
    surgery. A turn released and refused again, as one is when content
    reaches its compile after the check, is held again with its first
    deadline, and isn't released again until one of those changes.
  - **When it ends without running:** 30 minutes after the refusal that
    started it, or at once when compression has nothing pending, and the turn
    then fails as a refused compile did, its reason saying how long it was
    held. The 30 minutes also bound a compression that is pending but can't
    move, such as one whose model keeps failing. The hold lives in memory, as
    a turn in flight does: a restart drops it, and the agent's next wake
    compiles afresh.
  - **What the agent sees:** the held turn's compile carries a note saying
    why it waited, for that compile alone: "[budget-hold] Your context didn't
    fit its budget (100,201 tokens against 48,568), so this turn waited 7 min
    while compression caught up. It fits now." It's never stored. One held
    turn is one undo step, which keeps the messages that arrived while it
    waited.
  - **What hosts see:** the refused attempt still emits `inference:failed`, as
    a provider hold's does, so a module that brackets typing with it stops
    typing while the turn waits, and the turn's next start emits
    `inference:started` again. The logical turn stays open, so it settles when
    the held turn ends, up to 30 minutes later, rather than as exhausted
    within seconds. New traces `inference:held` and `inference:hold_ended`,
    and `healthSnapshot()` gives each agent's `budgetHold` (or null). The
    `context-refusal` ops alert goes out when the hold starts, and says the
    turn is held until its deadline.

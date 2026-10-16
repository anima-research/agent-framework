- A turn whose compile is refused for budget waits for compression and then
  runs, instead of ending (#304). The refusal comes before any provider call,
  for example after an immediate budget decrease. Before, the error policy
  retried it into the same refusal within seconds and ended the turn, and once
  compression had made the context fit, nothing ran it again, so the agent
  stayed silent until its next wake. Now a resident's or a conversation
  agent's turn is held while its context manager has compression pending.
  Later wakes join it. The hold leaves the provider gate open, so compression
  keeps running. An ephemeral run, and a refusal with nothing pending, fail
  as before.
  - **When it runs:** as one fresh compile, once context-manager's preview of
    that compile says it fits. A dry compile can't say so, since it doesn't
    throw an over-budget plan at its plan check. A refusal the preview
    rethrows, such as a context refusal, counts as a refusal. A strategy with
    no preview, or the hierarchical strategy, gets the dry compile. The hold
    looks after every maintenance pass, every drain kick it starts, and every
    surgery, undo and redo. It looks again only once something that could
    make the context fit has changed: compression's progress (for a strategy
    that reports none, whether it still has compression pending), the agent's
    message count, its runtime settings, or the store, by a surgery. An edit
    that shrinks a message is seen at the next compression step or surgery. A
    turn released and refused again is held again with its first deadline,
    and isn't released again until one of those changes.
  - **When it ends without running:** 30 minutes after the refusal that
    started it, or at once when compression has nothing pending, and the turn
    then fails as a refused compile did, its reason saying when it was first
    held. The 30 minutes also bound a compression that is pending but doesn't
    move. The hold lives in memory: a restart drops it, and the agent's next
    wake compiles afresh.
  - **What the agent sees:** the held turn's compile carries a note saying
    why it waited, for that compile alone: "[budget-hold] Your context didn't
    fit its budget (100,201 tokens against 48,568), so this turn waited
    7 min. It fits now." It's never stored. One held turn is one undo step,
    which keeps the messages that arrived while it waited. An undo while a
    turn is held rewinds past that turn's messages, and the held turn then
    runs on what the undo left (#381 is that for every pending wake).
  - **What hosts see:** the refused attempt emits `inference:failed`, and the
    turn's next start emits `inference:started` again. The turn's terminal
    event comes when the held turn ends, up to 30 minutes after the refusal,
    rather than as an exhaustion within seconds. New traces `inference:held`
    and `inference:hold_ended`, and `healthSnapshot()` gives each agent's
    `budgetHold` (or null). The `context-refusal` ops alert goes out when the
    hold starts (its `ops:alert` trace each time, its webhook post at most
    once per 15 minutes for an agent), and says the turn is held until its
    deadline. A hold's drain kicks log as `[budget-hold]`.

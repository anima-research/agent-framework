- A turn whose compile is refused for budget waits for compression and then
  runs, instead of ending (#304). The refusal comes before any provider call,
  for example after an immediate budget decrease. Before, the error policy
  retried it into the same refusal within seconds and ended the turn, and once
  compression had made the context fit, nothing ran it again, so the agent
  stayed silent until its next wake. Now a resident's or a conversation
  agent's turn is held while its context manager has compression pending, and
  it runs as one fresh compile once a dry-run compile fits, checked after
  every maintenance pass, drain kick and surgery. Later wakes join it. The
  hold never closes the provider gate, so compression keeps running. It ends
  after 30 minutes, or at once when compression has nothing left to do, and
  the turn then fails as a refused compile did, its reason saying how long it
  was held. An ephemeral run, and a refusal with nothing pending, fail as
  before.
  - **What the agent sees:** when the held turn runs, a system note in its
    context says why it waited: "[budget-hold] Your context didn't fit its
    budget (100,201 tokens against 48,568), so your turn waited 7 min while
    compression caught up. It fits now."
  - **What hosts see:** the logical turn stays open, so it settles when the
    held turn ends, up to 30 minutes later, rather than as exhausted within
    seconds. New traces `inference:held` and `inference:hold_ended`, and
    `healthSnapshot()` gives each agent's `budgetHold` (or null). The
    `context-refusal` ops alert goes out when the hold starts, and says the
    turn is held until its deadline.

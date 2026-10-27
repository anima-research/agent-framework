- A turn whose compile is refused for budget waits for compression and then
  runs, instead of ending (#304). The refusal comes before any provider call,
  for example after an immediate budget decrease. Before, the error policy
  retried it into the same refusal within seconds and ended the turn, and once
  compression had made the context fit, nothing ran it again, so the agent
  stayed silent until its next wake. Now a resident's or a conversation
  agent's turn is held while its context manager has compression pending, and
  later wakes join it. The hold leaves the provider gate open, so compression
  keeps running. An ephemeral run, a turn in a framework that `start()`
  hasn't started (only `runUntilIdle()` runs its turns, so nothing would run
  a released one), and a refusal with nothing pending fail as before. What a
  held turn changes for hosts is under Changed.
  - **When it runs:** as one fresh compile, once context-manager's preview of
    that compile, at its budget and with its thinking binding, says it fits.
    A dry compile can't say so, since it can resolve a plan the turn's
    compile refuses. A refusal the preview rethrows, such as a context
    refusal, counts as a refusal. A strategy with no preview gets the dry
    compile. The hierarchical strategy's preview reports a context that
    doesn't fit, and for one that does, the dry compile decides. The hold
    looks after every maintenance pass and every drain kick it starts. It
    takes a fresh verdict only once something that could make the context
    fit has changed: compression's progress or whether it still has
    compression pending, a message added, edited or removed (other than the
    arrival of a stored context injection, the hold's own note among them,
    or of a clock row), the agent's runtime settings, or the budget its next
    compile plans at. A turn released and refused again is held again with
    its first deadline, and isn't released again until one of those
    changes.
  - **When it ends without a fit:** 30 minutes after the refusal that started
    it, or at once when compression has nothing pending. The turn then runs
    if its context fits by then, and otherwise its refusal takes the error
    policy's path, as a refused compile did, its reason saying when it was
    first held. The 30 minutes also bound a compression that is pending but
    doesn't move. The hold lives in memory: a restart drops it, and the
    agent's next wake compiles afresh.
  - **Undo:** one held turn is one undo step. When the turn's first start is
    the one refused, it gives back the checkpoint it recorded, with the oldest
    one it evicted at the limit of 20, and the released start records the
    turn's, so the undo keeps the messages that arrived while it waited. When
    a retry is refused, an error policy's or a tool-result guard's, the turn
    keeps the checkpoint its first start recorded, before what it had done,
    and the undo takes the messages that arrived while it waited too. The
    redo its new work invalidated stays invalidated, as at any turn's first
    start.

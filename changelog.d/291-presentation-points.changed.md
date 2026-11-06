- What changes for a host now that each agent's context follows its own window (#291):
  - A quiesce freezes every window but for each agent's own rows: a write is stored at once, taking no clock row,
    and presented at resume, and a turn draining through the quiesce hears nothing at its tool boundaries. The
    clock row due by then is written at the agent's next turn start, after the write; before, resume stored the
    queued write through the path that writes a due clock row, so the clock row came first.
  - While a surgery holds the store (a rollback, a suppression, a branch switch), writes are held in memory and
    replayed in arrival order at its release, where each idle reader is presented them. A write whose due clock
    row's trace, or the trace of its stamp's audience check, starts one (a listener that switches the branch) is
    held behind it too, after its clock row. A write the release is replaying when such a listener starts one keeps
    its place at the head of the held writes, ahead of those that came after it, and stays listed until it is stored.
  - A row stored for an agent is in its context's record at once: a host that reads `getAllMessages()` sees rows
    its agent's window doesn't hold yet (`getPresentedMessages()` is the window).
  - A turn's continuation (a budget restart, a tool-result guard's retry) presents no arrival: a message stored
    while it was on its way enters the window as the turn ends, and its wake starts a turn of its own, where before
    it rode in the continuation's request.

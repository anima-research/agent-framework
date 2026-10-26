- What changes for a host now that each agent's context follows its own window (#291):
  - A quiesce freezes every window but for each agent's own rows: a write is stored at once and presented at
    resume, and a turn draining through the quiesce hears nothing at its tool boundaries.
  - While a surgery holds the store (a rollback, a suppression, a branch switch), writes are held in memory and
    replayed in arrival order at its release, where each idle reader is presented them.
  - A row stored for an agent is in its context's record at once: a host that reads `getAllMessages()` sees rows
    its agent's window doesn't hold yet (`getPresentedMessages()` is the window).
  - A turn's continuation (a budget restart, a tool-result guard's retry) presents no arrival: a message stored
    while it was on its way enters the window as the turn ends, and its wake starts a turn of its own, where before
    it rode in the continuation's request.

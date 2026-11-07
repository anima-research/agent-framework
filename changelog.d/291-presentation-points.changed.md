- What changes for a host now that each agent's context follows its own window (#291):
  - A quiesce freezes every window but for each agent's own rows: a write is stored at once, taking no clock row, and
    presented at resume, and a turn draining through the quiesce hears nothing at its tool boundaries. The clock row
    due by then is written at the agent's next turn start, after the write, where 0.32.0's resume wrote it ahead of
    the queued write.
  - A row stored for an agent is in its context's record at once: a host that reads `getAllMessages()` sees rows its
    agent's window doesn't hold yet (`getPresentedMessages()` is the window).
  - A turn's continuation (a budget restart, a tool-result guard's retry) presents no arrival: a message stored while
    it was on its way enters the window as the turn ends, and its wake starts a turn of its own, where in 0.32.0 a
    message stored while the continuation waited rode in the continuation's request.

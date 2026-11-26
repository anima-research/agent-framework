- A start that throws no longer loses other agents' requests (#620). A scheduler
  pass takes up agents one at a time. When one agent's start threw, the pass
  dropped the requests of the agents it hadn't reached yet, and traced nothing.
  Those agents then lost their wakes and turn continuations until something new
  woke them. Now those requests go back to the front of the queue, and the
  caller still gets the error. The requests that were merged into the failed
  start aren't queued again. If a stop drops a continuation during the pass, it
  stays dropped.

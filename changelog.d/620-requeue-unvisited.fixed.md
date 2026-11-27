- One agent's failed start no longer drops the requests of the agents behind it
  (#620). A scheduler pass takes up agents one at a time. When one agent's start
  threw, the pass dropped the requests of the agents it hadn't reached yet, and
  traced nothing. Those agents then lost their wakes and turn continuations until
  something new woke them. Now those requests go back to the front of the queue,
  and the next pass takes them up. The caller still gets the error. The requests
  that were merged into the failed start aren't queued again. If a stop drops a
  continuation during the pass, it stays dropped. If the fault is shared, such as
  a full disk, each of the next starts can fail the same way, with its own error.

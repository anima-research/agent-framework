- A coalesced `push/event` or `channels/incoming` message whose receipt the
  host couldn't write is no longer admitted again when the producer retries.
  The failed write was answered "host could not persist the acceptance; retry"
  after the occurrence's effects were in, and no receipt was kept. So each
  retry was a fresh admission: a copy the agent had read arrived again, a
  deferred notice rendered again, a deletion notice was appended again, and the
  answer named the occurrence's own eventId as `priorEventId`. Now the receipt
  is kept. A retry writes it again and makes it durable, then answers the first
  result without repeating an effect, as RFC-006 §3.1 has a coalescing host
  do. While the write keeps failing, each retry gets the same answer and
  repeats nothing. A retry that reaches a host restarted since, when nothing
  of the receipt was saved before the restart, as after a kill, is still
  admitted as a new occurrence.

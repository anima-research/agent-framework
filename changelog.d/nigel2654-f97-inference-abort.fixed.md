- **MCPL server authors:** a server's `inference/request` still running when
  the host calls `stop()` is now answered `-32000` "the host stopped while
  handling this request" (#418). Before, it got no answer, and failed on the
  server's side when the connection closed. It's the answer a request whose
  handler fails while the host is stopping already gets, so the server can
  send the request again to the host's next run. The host writes it before it
  closes the connection; a stdio server, which the close sends SIGTERM, may
  exit before it reads it.
- **Hosts:** `stop()` now aborts the provider call of each MCPL server's
  `inference/request` still running, in the step after it closes its queue.
  Before, the call ran on, and billed, until it finished or timed out, and its
  answer was dropped. The request's `mcpl:inference_fail` trace carries the
  stop answer's text. `stop()` then waits for each request to end, within its
  wait on modules and MCPL, so with a budget a `stop()` still takes up to six
  waits. A streamed request ends when membrane ends its stream, which
  membrane 0.8.0 does at the abort. A non-streamed one ends when its
  `complete()` settles, which with membrane 0.8.0 is at the abort too. A
  `complete()` that ignores the signal now holds `stop()` until that wait's
  budget runs out, or without a budget until the call ends, where before
  `stop()` didn't wait for it; the timeout names
  `inference/request:<server id>`.
- **Hosts:** when the transport an MCPL server's `inference/request` came on
  closes while its inference runs (the server's process exits, its connection
  drops, or the host closes or removes the server), the provider call is
  aborted, rather than running to its end for an answer nothing can receive.
  The host answers nothing, and when the abort ends the call, the request's
  `mcpl:inference_fail` trace says the transport the request came on closed;
  a call that completed before the abort reached it is traced as completed.

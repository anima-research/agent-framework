- **Late tool results, and MCPL pushes or incoming messages, at `stop()` no
  longer end in an unhandled rejection.** `stop()` closes the process queue
  before it closes MCPL connections, and nothing caught the "Queue is
  closed" that this meant for late arrivals. The race is older than the
  speech-route work.
  - A tool's result that arrives after `stop()` is logged and dropped. The
    stream that asked for it is gone, and the tool has already run. Before,
    its push threw, the throw was reported as the tool's own failure, and
    that failure's push threw again, unhandled. tune-out's results now go
    through the same `pushEvent` as every other tool's.
  - A server's `push/event` or `channels/incoming` that arrives once the
    host is stopping is refused before its handler runs, with a JSON-RPC
    error (`-32603`, "the host is stopping"). It is never answered
    "accepted".
  - A handler that throws, because the host stopped while it ran or because
    of a fault, is answered with an error too. Part of the request may
    already have been admitted. The error is never thrown out of the
    connection's listener. A notification is logged.
  - Direct input to `pushEvent` after `stop()` still throws to its caller.
- **`stop()` lets speech already written publish.** It waits for every
  agent's speech chain before the MCPL connections close, so words a turn
  wrote still go out, and again before the store closes, so what became of
  each is recorded (a publish that sent nothing keeps its words as a
  draft). Each wait is bounded at 10 s, and a chain still busy then is
  logged and left.

- A record of a server's text no longer throws when the configuration it's
  redacted with can't be read, as a legacy stdio MCPL server's can't while
  the Discord awareness ledger can't be read. In place of the text it reads
  `[withheld: the server's configuration couldn't be read to redact this]`.
  Before, on a legacy MCPL connection:
  - a reconnect attempt made while the ledger couldn't be read rejected with
    nothing to catch it, which by Node's default ends the process. The
    connection made no further attempt, and its `close()`, and with it the
    framework's `stop()`, rejected with the ledger's error;
  - an error its transport reported after the handshake settled, or while a
    transport that never served was closing, was thrown inside an I/O
    callback;
  - an initial connect with `reconnect: true` whose ledger broke after the
    framework's own read rejected with the ledger's error, which ended
    startup, instead of returning the stub that retries.

- Under a configuration a host passes with a getter that throws, a failed
  MCP or MCPL tool call now answers with the withheld words as its error,
  where a call the model or a `code_execution` script made got no result and
  an in-process call rejected; and startup goes on past that server's failed
  connect, where it ended.

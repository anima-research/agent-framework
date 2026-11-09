- **Hosts configuring MCP servers:** a `reconnectIntervalMs` or
  `reconnectMaxIntervalMs` that reads as 0, below 0 or not a number (such as
  `"abc"`, `false` or `NaN`) is now refused where it's used: on an entry
  with `reconnect: true`, and on any server the modern engine runs, which
  also uses them to back off reopening a lost tool-list subscription (#375).
  `create()`, `connectMcplServer` and `restartMcplServer` refuse it before
  anything opens, and `serverConfigProblems` lists it, naming the server and
  the field, and the value when it's a number. Each of those values retried
  at once on every attempt.
  - At `create()`, such an entry fails that server alone at startup, as an
    unusable `requestTimeoutMs` does: it's logged, traced as
    `mcpl:server-connect-failed` and alerted as `mcpl-down`, and the other
    servers are brought up.
  - **Migration:** give the field a number of milliseconds above 0, or leave
    it out (or `null`) for its default, 5000 for `reconnectIntervalMs` and
    300000 for `reconnectMaxIntervalMs`.
  - **Unchanged:** a legacy entry that doesn't reconnect isn't checked, since
    it never uses them; `null` still means the default, and a numeric string,
    a cap below the interval, Infinity and caps past a timer's limit are
    still accepted.
  - **Sibling versions:** none raised; no sibling package needs a new
    version.

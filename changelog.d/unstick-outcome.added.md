- **`host/command` `unstick-outcome` tells a surface how an `/unstick` came out, as labels.** It takes
  `agentName` and answers `{ ok: true, outcome, rewinds, cause? }`. `outcome` is `cleared`, `gave-up`,
  `turn-failed`, `agent-ended` or `host-stopped`, and `rewinds` counts the turns the session had set aside. `cause`
  is `{ kind: 'refusal', category }` for `gave-up`, and `{ kind: 'failure', type?, status? }` for `turn-failed`: the
  failed turn's type and HTTP status as the framework classes them, `safety` included. It never holds a provider's
  message or explanation. Each request is answered once, at the next of the session's end or a turn of the agent
  that runs out of retries inside the session. `turn-failed` ends no session and posts nothing. An end is kept, and
  every request after it gets it at once, until the agent's next `unstick`. A `turn-failed` that no request waited
  for is kept for the first request that comes, until a later answer replaces it or the agent's next `unstick` drops
  it. A new `unstick` answers the agent's requests that still wait with `ok: false`, before its session starts. With
  no session and nothing kept, it answers `ok: false`. While it waits it holds back no other command, and a stop
  answers it `host-stopped`. The framework stores no row and sends
  no request for an answer. The `unstick` acknowledgement gains `outcome: true` and `agentName`, the agent its
  session is on, so a surface asks only a host that answers, and about the agent the session took.

- Hosts can register `setHostCommandHandler(handler | null)` for MCPL servers
  configured with `allowHostCommands: {only: ['operator']}`. This control role
  forwards only `operator` envelopes unchanged, including while quiesced, and
  cannot reach legacy admin commands. Boolean/default authority is unchanged.
  The handler's third argument, `runBuiltIn(params)`, lets the host run a
  built-in verb it chooses — including `unstick` and `unstick-outcome` — with
  the same checks and answers as an `allowHostCommands: true` server.
  `HostCommandParams` and `HostCommandResult` are exported.
  `listMcplServers()` reports such a server's `allowHostCommands` as
  `'operator-only'`; `true` and `false` servers report as before.

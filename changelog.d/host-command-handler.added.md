- Embedding hosts can register a `setHostCommandHandler` hook for MCPL servers
  configured with `hostCommandRole: 'operator'`. The role admits only the
  `operator` verb of `host/command`, including while the host is quiesced,
  without putting it into chat or waking a model. The host can opt to run a
  built-in command through `runBuiltIn` with the same checks and answers as
  direct built-in access.
  `allowHostCommands` remains boolean and grants unchanged built-in authority
  when true. Configuring both opt-ins on the same server is an error.
  `listMcplServers()` reports direct built-in access in `allowHostCommands`
  and reports hook-only access separately in `hostCommandRole`.

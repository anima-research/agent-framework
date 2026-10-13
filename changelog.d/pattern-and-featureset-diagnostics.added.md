- Tool-name patterns that match no tool are reported. This covers
  `toolClassOverrides` keys and `toolLifecycle.observe.tools` /
  `toolLifecycle.inputs.tools`. Each pattern is reported once, as a console
  line and an `mcpl:tool-pattern-unmatched` trace. A pattern written against
  the bare server id gets the `mcpl--<serverId>--…` form suggested, since
  that is the default tool prefix. A pattern that could name a server's tools
  waits until that server has listed them.
- Two disablements that were only console lines are now also traces.
  `mcpl:feature-set-disabled` covers a feature set that §6.4 derivation turns
  off, for example one that declares no `uses` while `enabledFeatureSets`
  lists it. `mcpl:policy-refused` covers a server refusing the host's policy,
  with its `fallback`.
- README documents MCPL tool naming (`<toolPrefix>--<tool>`, default prefix
  `mcpl--<serverId>`) and how `enabledFeatureSets` behaves. The `toolPrefix`
  doc comment now shows the real `--` separator.

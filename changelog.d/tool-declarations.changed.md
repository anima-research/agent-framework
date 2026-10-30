- An agent on its head (`toolDeclarations: 'head'`, the default), which sends
  no system change, now leaves change rows out of what it compiles too, so a
  host's `system_change` rows no longer count against its budget. Every
  context manager the framework opens for such an agent leaves them out of its
  view: a resident's, an ephemeral agent's, isolated or derived, a resumed
  agent's and a conversation fork's. An inspection (`inspectAgentContext`)
  still shows the change rows stored. The subconscious's view is as it was,
  since it already left out every change row not its own.
- A resident's registry record now states its `selfParticipants` and
  `presentAs`, as a derived agent's does, so `inspect` shows them and a
  context reopened from records reads the mapping that ran.
- kv-unified's immutable-prefix hash takes an agent's tools as the wire
  carries them, leaving out a field whose value is undefined, as membrane's
  request does, where it wrote such a field as null. A host whose tool
  definitions carry one, built as objects rather than parsed from JSON, gets
  one fresh layout at the upgrade, on `'head'` too.
- A system change row is never a message said to an agent: it restarts no
  re-send count, clears no earlier deadline cut of a re-armed turn
  (agent-framework#871), counts as nothing heard, moves no turn to a channel,
  and isn't where a turn's `agent-framework:turn-inputs` pin starts, whatever
  its metadata, so it joins what 0.29.0's re-arm entry (agent-framework#838)
  lists as not a message said to the agent. A row the agent's own view leaves
  out, such as another resident's change, or for the subconscious any change
  not its own, is stored but not injected into its live turn at a tool
  boundary, and isn't noted as said to it or heard; and for an agent on its
  head, which sends no change row, neither is any change row stored at its
  tool boundary injected.
- Whether an MCPL event's own entry is the newest in the window a batched
  wake's `[Gate: …]` line goes to now reads past any number of clock rows,
  stored context injections, system changes and rows the agent's view leaves
  out. Past 32 of them it used to answer no, so the line was written rather
  than handed to the wake.

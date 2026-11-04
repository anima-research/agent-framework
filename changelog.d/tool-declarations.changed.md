- An agent on its head (`toolDeclarations: 'head'`, the default) now sends no
  system change: a host's `system_change` rows in its context, which its
  requests carried before, stay out of them, and out of what it compiles, so
  they no longer reach its model or count against its budget. Every
  context manager the framework opens for such an agent leaves them out of its
  view: a resident's, an ephemeral agent's, isolated or derived, a resumed
  agent's and a conversation fork's. An inspection (`inspectAgentContext`)
  still shows the change rows stored. The subconscious's view is as it was,
  since it already left out every change row not its own.
- The history module's `extract` returns a system change as its type alone
  with `format: "raw"`, and as `[system change]` with `"text"`, since what it
  declared may be another agent's tools and system text. Its tool description
  says so, so an agent with the history module has its tools written to the
  provider's cache afresh once at the upgrade.
- Going back to a release from 0.26.0 on, after an agent has declared changes
  under `'entries'`: that release compiles the stored change rows as it does
  any row. Through membrane's native formatter to an adapter that sends system
  changes, a request carries them as written beside its current head, and a
  resident's request in the residents' shared slot carries the other
  residents' as well; through any other, membrane refuses a request that
  carries one. A release before 0.26.0 depends on a membrane with no system
  changes at all.
- A resident's registry record now states its `selfParticipants` and
  `presentAs`, as a derived agent's does, so `inspect` shows them and a
  context reopened from records reads the mapping that ran.
- kv-unified's immutable-prefix hash takes an agent's tools as the wire
  carries them, as JSON writes them: a field whose value is undefined is left
  out, as membrane's request does, where it was hashed as null, and a value
  JSON writes as text, such as a Date, is hashed as that text, where it was
  hashed as an empty object. A host whose tool definitions carry either,
  built as objects rather than parsed from JSON, gets one fresh layout at the
  upgrade, on `'head'` too.
- A request's tools are a copy of the agent's tools as JSON writes them, on
  `'head'` too: a value JSON can't write, such as a BigInt, fails as the
  request is built, where it failed once the request was serialised to be
  sent, and a field JSON leaves out, such as a function, is left out of the
  request as it was of what was sent.
- A message-count undo (`/undo` with `messages`) counts every message but
  system change rows: the change rows among the last N go with them
  uncounted, and a refusal's count of the messages the history holds leaves
  them out.
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

- A host's `system_change` rows no longer count against the budget of an
  agent on its head (`toolDeclarations: 'head'`, the default) whose context
  manager the framework opens, since its compile leaves them out, as its
  request now does (see Breaking).
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
- A system change row, a host's or an agent's own, isn't a row a reply
  could be meant for. So a change row stored after a batched wake's messages
  doesn't make the turn's start write the wake's `[Gate: …]` line, as a
  clock row doesn't. This holds in a presented window and in one still in
  legacy mode.

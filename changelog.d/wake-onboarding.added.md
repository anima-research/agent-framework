- Wake onboarding: the first event from an MCPL server that the agent's wake
  rules let go by without deciding about it — skipped by the gate's default, or
  by a rule that names neither its server, its channel nor its tags, such as a
  `discord-ambient` catch-all — brings the agent a `[wake onboarding]` notice
  with that server's suggested treatment (MCPL RFC-001 §5 `suggestedTreatment`,
  or the deprecated `defaultTreatment`), numbered, with each rule's
  `rationale`. An event tagged `chat:addressed`, `surface:turn`, `surface:alert`
  or `surface:invite` wakes the agent to decide; any other leaves the notice for
  its next turn. A server that suggests nothing usable gets one host-written
  rule: wake for its events tagged that way. Offered once per declared ontology
  (a digest of it, kept in `wake-decisions.json` beside `gate.json`), and at
  most once a day per server. `gate.onboarding: false` turns it off.
- `wake_accept_suggestions { server, rules? }` writes the chosen suggestions as
  `suggested:<server>:<n>` rules matching only that server's events, ahead of
  the first catch-all, replacing any accepted before; `wake_decline { server }`
  removes them and records the decline. Both are in the built-in settings
  toolset. Nothing a server suggests is applied without one of them (RFC-001
  §5.2).
- `gate_status` names the first rule that takes MCPL events without naming a
  server, a channel or a tag (`catchAll`); `event_tags` shows each connected
  server's offer and the decisions recorded (`onboarding`). The `tagOntology`
  declaration type reads `suggestedTreatment`.

- A persistent subconscious, or a resident that observes another
  (`observes`), whose window write-down failed at registration is now sent
  other agents' rounds as its `foreignRounds` says (a transcript by
  default) once a branch move presents its window. Before, it stayed in
  `'raw'` for the rest of the process, so other agents' thinking and tool
  calls went out to it as stored. Each branch move sets the mode again: the
  configured one where the agent's window is presented, `'raw'` where it
  stays the record.
- In a transcript, a call answers one result: another agent's result whose id a call of the watcher's had, and
  which comes after that call's own result (its own call compressed out of the request), is now sent as a line
  ("a tool returned: …") rather than as a second result of the watcher's call (#291).
- An agent derived from one that is sent other agents' rounds as a transcript (`deriveAgent`, shared or copy), and
  a conversation fork of such a template, are now sent them so too: their inheritance holds the rounds the parent's
  window held. Before, their registration set no mode, so the observed agent's thinking and tool calls went out to
  them as stored (#291).

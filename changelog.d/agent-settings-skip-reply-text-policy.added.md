- **`agent_settings` shows and switches the agent's own
  `sameRoundSkipReplyTextPolicy`** as `same_round_skip_reply_text_policy`
  (`'private'` or `'ask'`), in the form `send_silencing` has. `get` shows
  the value in force: the agent's own choice, else its config's, else
  `'private'`. `update` sets the agent's choice, and `reset` takes it off
  when it names the field in `settings` or names nothing. The choice
  overrides the config, persists with the agent's other runtime settings,
  and applies from the agent's next response on at the latest. On native
  tools, a `skip_reply` in the response that changes it is under the old
  value. On the XML tool path, the hold at the turn's end reads the value
  in force then, so a change in the same response applies to it. A
  change made while a response is being written, by the host or by a script
  still running from an earlier turn, can apply to that response. The
  guard, a cut-off round, the XML tool path's hold at the turn's end and
  the heartbeat notice read the value in force.
  A heartbeat notice is written as its turn starts, so a change inside a
  heartbeat turn shows in the next one's notice.
  `AgentRuntimeSettingsPatch` and `AgentRuntimeSettingsSnapshot` carry
  `sameRoundSkipReplyTextPolicy` (a required field of the snapshot type, so
  a typed fixture or mock of one needs it). A stored value other than
  `'private'` or `'ask'` is refused at a start, as a stored think-text
  policy is.
  - A derived agent and the subconscious still start at `'private'`,
    whatever the agent's own choice, as they don't take its config's value.
  - Tool text: `agent_settings`' description and schema name the setting.
    At the upgrade the tool block changes once for every agent that has
    `agent_settings`, and a changed block misses the provider's prompt cache
    once.
  - After a rollback to 0.35.0 or 0.34.0, a stored choice is ignored and
    the config's value applies. A persisted update, reset or cancel there of
    the agent's budget, tail, pace, think-text policy or `send_silencing`
    writes the record without the choice.

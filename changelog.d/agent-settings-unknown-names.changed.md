- `agent_settings` refuses an update that names something that isn't a setting
  (`Unknown setting: tail_token`), or names `settings`, which only a reset
  reads, where it dropped the name unseen and answered as if the call had
  succeeded. A reset refuses a name beside `settings` the same way, where it
  dropped the name and, with no `settings` list, reset everything. A reset
  also refuses a name in `settings` that is inherited, such as
  `constructor`, which it took as a setting and reset nothing, and a module
  setting whose extension has no `reset`, which it skipped and answered as
  reset. A cancel refuses any name beside `action`, where it ignored the name
  and cancelled.
- `agent_settings` refuses `null`, `true` or `false`, a list, an object or
  blank text for a numeric setting (`context_budget_tokens`, `tail_tokens`,
  `transition_pace_tokens`, `tool_result_inline_max_chars`). Each was read as
  a number, and applied where that number was in range: `tail_tokens: null`,
  `false` or `""` set the tail to 0, `true` set the tail or the pace to 1,
  and a one-item list such as `[20000]` set any of the four to its item.
  Text that reads as a number, such as `"20000"`, is still taken, and text
  that doesn't, such as `"abc"`, is refused as before, now saying it must be
  a number.
- `agent_settings` refuses `immediate` given as anything but true or false,
  or the text `"true"` or `"false"`. It was read with `Boolean()`, so `1`,
  `"yes"` or a list applied a lower budget at once, and `0`, `null` or `""`
  paced it.

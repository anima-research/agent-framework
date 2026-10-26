- `agent_settings` refuses an update that names something that isn't a setting
  (`Unknown setting: tail_token`), or names `settings`, which only a reset
  reads, where it dropped the name unseen and answered as if the call had
  succeeded. A reset refuses a name beside `settings` the same way, where it
  dropped the name and reset everything, and a cancel refuses any name beside
  `action`, where it ignored the name and cancelled.
- `agent_settings` refuses `null`, `true` or `false`, a list, an object or
  blank text for a numeric setting (`context_budget_tokens`, `tail_tokens`,
  `transition_pace_tokens`, `tool_result_inline_max_chars`), where each was
  read as a number: `tail_tokens: null` or `""` set the tail to 0, and
  `tail_tokens: [20000]` set it to 20000. Text that reads as a number, such
  as `"20000"`, is still taken.

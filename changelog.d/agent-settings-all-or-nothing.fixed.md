- `agent_settings` changes all of a call's settings or none of them. Every
  setting a call names, the core ones and each extension's, is checked before
  any is applied, so a refused call leaves everything as it was, and its error
  ends with "Nothing in this call was changed." Before, the `tool_result_*`
  settings and a module's settings were applied before the core settings were
  checked, so a call refused for its `tail_tokens` had already changed its
  inline cap. A reset that can't run (a configured budget below the live one,
  on a strategy that can't lower the budget gradually) is now refused before
  it resets any extension's settings, where it reset them and then refused.
- `agent_settings` refuses an update that names something that isn't a
  setting (`Unknown setting: tail_token`), where it dropped the name unseen and
  answered as if the call had succeeded.

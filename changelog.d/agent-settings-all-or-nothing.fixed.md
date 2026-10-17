- `agent_settings` checks every setting a call names before it applies any,
  as far as a check can tell: the names, the core settings' own checks and
  each extension's `validate`. A call those checks refuse leaves everything as
  it was. Before, the `tool_result_*` settings and a module's settings were
  applied before the core settings were checked, so a call refused for its
  `tail_tokens` had already changed its inline cap. What a check can't foresee
  (an extension without `validate`, the budget preflight, which judges the
  agent as those extensions left it, the context strategy's own refusal, a
  store write that fails) can still refuse after something applied, so what
  can refuse goes first: in an update, extensions without `validate`, then
  the core settings, then extensions that checked ahead; in a reset, the core
  settings, then the extensions.
- An `agent_settings` update or reset refusal ends by saying what the call
  changed: "Nothing in this call was changed.", or "Changed before the
  refusal: …", naming each setting whose applied or saved value differs from
  before the call, or, if the settings can't be read back, that whether
  anything changed couldn't be.
- `agent_settings` refuses an update that names something that isn't a setting
  (`Unknown setting: tail_token`), or names `settings`, which only a reset
  reads, where it dropped the name unseen and answered as if the call had
  succeeded. A reset refuses a name beside `settings` the same way, where it
  dropped the name and reset everything.
- The budget preflight's notes, such as a paced descent that will converge
  only as far as the folded floor, are logged once the budget has applied,
  not before a refusal that leaves it unapplied.

- `agent_settings` applies an update's or a reset's settings in one order:
  the core settings first, then each extension's. So a refusal from the core
  (a value out of range, a lower budget the strategy can't reach gradually,
  the budget preflight, the strategy's own refusal) leaves every extension's
  setting in the call as it was. Before, both applied the extensions'
  settings first, so a call refused for its `tail_tokens` had already
  changed its inline cap.
- An `agent_settings` update or reset refusal ends by saying what the call
  changed: "Nothing in this call was changed.", or "Changed before the
  refusal: …", naming each setting whose applied or saved value differs from
  before the call, or, if the settings can't be read back, that whether
  anything changed couldn't be.
- `agent_settings` reads `immediate`, `tool_result_guard` and
  `closed_channel_note` given as the text `"true"` or `"false"` as that
  boolean. Before, `immediate: "false"` applied a lower budget at once where
  the call asked for it paced, and the other two refused the text.

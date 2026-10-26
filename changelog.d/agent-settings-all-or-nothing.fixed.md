- `agent_settings` applies an update's or a reset's settings in one order:
  the core settings first, then each extension's. So a refusal from the core
  (a value out of range, a lower budget the strategy can't reach gradually,
  the budget preflight, the strategy's own refusal) leaves every extension's
  setting in the call as it was. Before, both applied the extensions'
  settings first, so a call refused for its `tail_tokens` had already
  changed its inline cap.
- An `agent_settings` update, reset or cancel refusal ends by saying what the
  call changed. One made before anything applied ends "Nothing in this call
  was changed." One made after names each setting that reads differently
  than before the call ("Changed before the refusal: …; no other setting
  reads differently."), or says "No setting reads differently after this
  call.", or, if the settings can't be read back, says that whether anything
  changed couldn't be.
- `agent_settings` reads `immediate`, `tool_result_guard` and
  `closed_channel_note` given as the text `"true"` or `"false"` as that
  boolean. Before, `immediate: "false"` applied a lower budget at once where
  the call asked for it paced, and the other two refused the text. Their
  refusals now read `… must be true or false, not <value>`, where the
  guard's and the note's read `… must be a boolean`.

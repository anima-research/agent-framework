- `SpeechContext.private`: `true` when the turn is private: it held an
  operator's private message (one from a surface with no channel, such as a
  console, the TUI or an API call), or it continues a turn that did. Its plain
  speech goes to no channel unless the agent names one, so a speech handler
  that publishes the speech it hears should post none of it.

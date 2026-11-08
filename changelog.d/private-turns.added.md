- `SpeechContext.private`: `true` when the turn holds an operator's private
  message (one from a surface with no channel, such as a console, the TUI or an
  API call), so its speech goes to no channel. A speech handler that publishes
  the speech it hears should post none of it.

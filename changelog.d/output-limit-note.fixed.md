- When the output limit (`max_tokens`) cuts a reply in plain prose, the
  agent now gets a note after the reply: "[output-limit] The output limit
  was reached in the response just before this note. The rest was not
  generated." Only a turn that the framework drives writes the note. The
  agent reads the note at its next turn. Before, nothing set such a reply
  apart. A cut tool call still gets its own notice instead. The reply is
  stored and routed as before (part of #135). The caller of an ephemeral
  run still gets the cut text as `speech`, with no mark, since the note
  stays in the run's own context. `Agent.runInferenceWithInjections()`
  writes no note, and its caller gets the stop reason. Supplied text that
  opens with `[output-limit` is now marked, as for any other notice tag.

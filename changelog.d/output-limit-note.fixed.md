- When the output limit (`max_tokens`) cuts a reply in plain prose, the
  agent now gets a note after the reply: "[output-limit] The output limit
  was reached in the response just before this note. The rest was not
  generated." Before, nothing set such a reply apart. A cut tool call
  still gets its own notice instead. The reply is stored and routed as
  before (part of #135). Supplied text that opens with `[output-limit` is
  now marked, as for any other notice tag.

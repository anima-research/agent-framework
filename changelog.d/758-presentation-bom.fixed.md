- A tool presentation file or a description defaults file saved as UTF-8 with
  a leading byte order mark, as some Windows editors save a hand-edited file,
  is read like the same file without one. Each was refused as "isn't valid
  JSON". For a presentation file, none of its settings applied, and
  `set_tool_visibility` and `set_tool_description` refused to write until it
  was repaired (#758). For a defaults file, the descriptions it sets didn't
  apply. Exactly one leading U+FEFF is skipped, as `gate.json` already does
  (#395).

- A tool result whose `data` is a string now reaches the model as that text.
  It was JSON-encoded on the way, quoted with every newline, tab and quote
  escaped, so a multi-line answer, such as a module tool's line-per-item
  listing, arrived as one escaped line: in context, on the live wire, and in
  its spill file under `tool-results/`, which `workspace--read` could then
  page only by character and `workspace--grep` matched as a single line. A
  spill file now holds the string as the tool returned it. Data that isn't a
  string reaches the model as before.

  Results stored before the upgrade keep the quoted text they were stored
  with, so a conversation shows both forms until its older results leave
  its context. A string is measured as its own text, so one whose JSON form
  went over the inline cap while its text doesn't, such as a long listing
  of short lines, now stays inline where it used to spill to a file. A lone
  UTF-16 surrogate in the string, which JSON escaped, reads as U+FFFD. For
  a result without an error, `data: ''` reads as an empty result, as
  `data: undefined` already did.

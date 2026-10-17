- A tool result whose `data` is a string now reaches the model as that text.
  It was JSON-encoded on the way, quoted with every newline, tab and quote
  escaped, so a multi-line answer, such as a module tool's line-per-item
  listing, arrived as one escaped line: in context, on the live wire, and in
  its spill file under `tool-results/`, which `workspace--read` could then
  page only by character and `workspace--grep` matched as a single line. A
  spill file now holds the string as the tool returned it. Objects, numbers,
  booleans and arrays other than MCP content arrays are still sent as JSON,
  and MCP content arrays as their blocks.

  For a result without an error, `data: ''` is stored as no text, as
  `data: undefined` already was.

- **Script authors (`code_execution`):** a script's tool function now
  returns a tool's text result as that text, where it returned the text
  JSON-encoded. That covers every MCP tool whose result is text only, and
  every module tool whose `data` is a string. Drop a `json.loads` that only
  unquoted such a result. Where the text is itself JSON, one `json.loads` now
  returns the data, so drop the second. Unchanged: an object, a number, a
  boolean, or an array other than an MCP content array still arrives as its
  JSON.

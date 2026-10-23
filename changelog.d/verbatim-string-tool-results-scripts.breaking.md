- **Script authors (`code_execution`):** a tool's text result now reaches a
  script as that text, in its result's `content[0].text`, where it was the
  text JSON-encoded. That covers every MCP tool whose result is text only,
  and every module tool whose `data` is a string, without structured
  content. A script saved before the upgrade meets the change too. Drop a
  `JSON.parse` that only unquoted such a result. Where the text is itself
  JSON, one `JSON.parse` now returns the data, so drop the second. A script
  that read every result with `JSON.parse` can parse inside a `try` and
  keep the text when it throws; a string whose text is itself JSON, such as
  the text `123` or `true`, then reads as the value it spells. A result
  whose data isn't a string, and a result with structured content, reach a
  script as before.

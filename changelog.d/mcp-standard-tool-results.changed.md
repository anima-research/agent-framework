- MCP tool results from servers that aren't MCPL peers (MCP-only legacy
  servers and modern servers) are now read by their content types:
  - text stays text, and inline images stay native;
  - audio and binary resources are saved to the workspace (`tool-results/`),
    with a bounded stub saying where;
  - a `resource_link` is shown as a reference and never fetched;
  - an embedded text resource shows its text.

  Before, any non-text block turned the whole result into raw JSON.
  `structuredContent` is now kept by presence on the new
  `ToolResult.structured`, so `false`, `0` and `null` are values. The model
  sees it as JSON only when the content carries no text; a structured-only
  result used to reach the model as an empty string. Scripts receive
  `{ content, structuredContent, isError }` as one JSON object whenever a
  result has structured content. MCPL peers keep their RFC-005 reading and
  gain `structured`.
- The direct tool path (`executeToolCall`, `ModuleContext.callTool`) now
  treats an MCP tool error (`isError: true`) as a failure (`success: false`
  with the error text), as the model path does. Before, every answer counted
  as success. Its `data` now has the model path's shape too: text joined into
  a string, or an array when an image is present.
- Closing a stdio MCP/MCPL server now waits for the child to exit. A child
  still alive 2 s after SIGTERM gets SIGKILL. Before, close returned as soon
  as the signal was sent.

- What the model sees of an MCP tool result from a server that isn't an
  MCPL peer (an MCP-only legacy server, or a modern server) now follows its
  content types:
  - text stays text, and inline images stay native;
  - audio and binary resources are saved to the workspace (`tool-results/`),
    with a bounded stub saying where. If a payload can't be saved, the result
    is reported as incomplete (`isError`), noting the tool may already have
    completed, never as a success with part of it missing;
  - a `resource_link` is shown as a reference and never fetched;
  - an embedded text resource shows its text.

  Before, any non-text block turned the whole result into raw JSON.
  `structuredContent` is kept by presence on the new `ToolResult.structured`
  (`false`, `0` and `null` are values). The model sees it as JSON when the
  server's content has no text block of its own; a structured-only result
  used to reach the model as an empty string. MCPL peers keep their RFC-005
  reading and gain `structured`.
- A script whose tool call returns `structuredContent` receives the
  server's result itself, as one JSON object: `{ content, structuredContent,
  isError, error? }`, with `content` the blocks as sent, so images and other
  payloads survive. If it would exceed the 5 MB script cap, it is saved to the
  workspace and the script gets `{ isError, oversized: { chars, savedTo } }`.
  If it can't be saved, the script gets a failure that says the tool may have
  completed. Results without structured content keep the existing script
  contract.
- The direct tool path (`executeToolCall`, `ModuleContext.callTool`) now
  treats an MCP tool error (`isError: true`) as a failure, with
  `success: false` and the error text; before, every answer counted as
  success. `data` is still the raw content array, and `structured` is added
  when the server sent one.
- Closing a stdio MCP/MCPL server now waits for the child to exit, sending
  SIGKILL after 2 s. A child still alive 2 s after SIGKILL fails `close()`
  with an explicit error. Before, close returned as soon as a signal was
  sent. `stop()` reports such a failure and still finishes shutting
  everything else down.
- A server configuration naming no usable transport is now an error before
  anything is spawned or dialed. That covers a `transport` that doesn't
  match the url's scheme, `transport: 'http'` without a url, and an
  unrecognized scheme. Every valid configuration resolves as before.

- The tool catalogue a resident reads with `workspace--read` now lists the
  available tools hidden from it right after its header and any
  diagnostics, before the index: each with its source and the description it
  would show (its own override, else the configured default, else the
  installed one). Deciding whether to show one again no longer takes a read
  per hidden tool at its own offset, or a read through every visible tool's
  description, which the request already holds. The index and full
  definitions follow, so a long hidden section pushes the index past the
  first 140 lines, and each hidden description appears twice in the file. A
  hidden tool that isn't available right now is still named only in the
  diagnostics. The unknown-name refusal of `set_tool_visibility` and
  `set_tool_description` now says the resident has no tool by that name
  right now, shown or hidden, where it said none was "available to you",
  which can read as a lack of access.

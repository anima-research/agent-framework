- The tool catalogue a resident reads with `workspace--read` now opens with
  the tools it has hidden, each with its source and the description it would
  show (its own override, else the configured default, else the installed
  one), before the index. Deciding whether to show one again no longer takes
  a read per hidden tool at its own offset, or a read through every visible
  tool's description, which the request already holds. The unknown-name
  refusal of `set_tool_visibility` and `set_tool_description` now says the
  resident has no tool by that name, shown or hidden, where it said none was
  "available to you", which can read as a lack of access.

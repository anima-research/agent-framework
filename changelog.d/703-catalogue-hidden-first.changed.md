- The tool catalogue a resident reads with `workspace--read` now lists the
  available tools hidden from it right after its header and any
  diagnostics, before the index: each with its source and the description
  it would show (its own override, else the configured default, else the
  installed one). Deciding whether to show one again no longer takes a
  read per hidden tool at its own offset, or a read through every visible
  tool's description, which the request already holds. Each description
  line there, split at each line break, CR, LF and Unicode's others alike,
  is quoted (`> `), so none is the same as one of the catalogue's own
  headings or index rows. The index and full definitions follow, so a long
  hidden section pushes the index past the first 140 lines, and the header
  says which line the index starts on. Each hidden description appears
  twice in the file. A hidden tool that isn't available right now is still
  named only in the diagnostics. The unknown-name refusal of
  `set_tool_visibility` and `set_tool_description` now says the resident
  has no tool by that name right now, shown or hidden, where it said none
  was "available to you", which can read as a lack of access. When the
  resident's file holds that exact name, the refusal also says its setting
  stays, which the resident can change if it has a tool by that name. A
  file this host can't read or parse holds no setting.

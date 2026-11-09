- The tool catalogue a resident reads with `workspace--read` now lists the
  available tools hidden from it right after its header and any
  diagnostics, before the index: each with its source and the description
  it would show (its own override, else the configured default, else the
  installed one). Deciding whether to show one again no longer takes a
  read per hidden tool at its own offset, or a read through every visible
  tool's description first. Each description line there, split at each
  line break, CR, LF and Unicode's others alike, is quoted (`> `, or a
  bare `>` for an empty line), so none is the same as one of the
  catalogue's own headings or index rows. The index and full definitions
  follow, so a long hidden section pushes the index past the first 140
  lines, and the header says which line the index starts on. That header
  line is new, so every line reference in the catalogue moves down by at
  least one, even with nothing hidden. The catalogue's revision doesn't
  cover its layout, so this change leaves the revision as it was, and a
  line reference saved before the upgrade reads the wrong lines under the
  same revision; the header's remedy, rereading the index after changes,
  still applies. Each hidden description appears twice in the file. A
  hidden tool that isn't available right now is still named only in the
  diagnostics. The unknown-name refusal of `set_tool_visibility` and
  `set_tool_description` now says the resident has no tool by that name
  right now, shown or hidden, where it said none was "available to you",
  which can read as a lack of access. When the resident's file holds a
  setting under that exact name, the refusal says its setting stays, which
  the resident can change if it has a tool by that name, and leaves out
  the instruction to copy the name from the catalogue's index, which lists
  only available tools. When this host can't read or parse the file, the
  refusal can't tell whether it holds the name, and gives that
  instruction. An entry that holds no setting, as restoring a tool's only
  description leaves it, is no longer named "Not currently available"
  once its tool goes away, as 0.32.0 and 0.33.0 named it, so the
  diagnostics and the refusal agree on which names the file keeps a
  setting for.

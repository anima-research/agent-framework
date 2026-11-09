- The tool catalogue a resident reads with `workspace--read` now lists the
  available tools hidden from it right after its header and any
  diagnostics, before the index: one line each, with its source, the
  first line with text of the description it would show (its own
  override, else the configured default, else the installed one), quoted
  as JSON and, past 200 characters, cut and followed by its length, and
  the offset and limit of its full definition. A resident deciding whether
  to show one again finds them all before the index, where it took a read
  per hidden tool at its own offset, or a read through every visible
  tool's description first. The header says which line the index starts
  on. That header line is new, so every line reference in the catalogue
  moves down by at least one, even with nothing hidden. The catalogue's
  revision now covers its layout too, so every catalogue's revision
  changes once at the upgrade, and a line reference saved before it
  belongs to a revision the catalogue no longer shows. A hidden tool that
  isn't available right now is still named only in the diagnostics. The
  unknown-name refusal of `set_tool_visibility` and `set_tool_description`
  now says the resident has no tool by that name right now, shown or
  hidden, where it said none was "available to you", which can read as a
  lack of access.

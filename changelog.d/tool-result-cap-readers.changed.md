- A cut tool result's spill notice, which names the workspace file holding
  the rest, now survives every reader's per-message cut until a turn's
  notices alone fill the bound, or a mount name past about seventy
  characters makes the notice longer than its room. Past six results at a
  bound of 4,000, or 62 at 40,000, a turn's share is under the notice's
  room, so each result longer than its share is stored as its notice alone,
  with no head; where a workspace is writable, its file holds the whole
  result. Past about 11 results at 4,000, or 119 at 40,000, the notices
  themselves pass the bound, and the reader's cut takes the later ones. An
  ordinary
  resident's inline cap is at most the smallest per-message bound among the
  agents that read the shared slot, and `agent_settings` get reports a cap
  set by another reader's bound as
  `tool_result_inline_max_chars_clamped_by: "reader-bound"`. Where a cut
  result's stored copy, notice and kept image slots included, would pass
  that bound, its head moves back until it fits, and image slots that still
  don't fit keep the newest. A reader's strategy spends its bound across a
  message, and a turn's results are stored as one message, so where they
  pass the bound together, which used to cut or leave out a later result
  silently, each now takes an equal share of it. A turn whose results fit is
  stored as each result would be alone, unless a `save_recent_image` in it
  counted a result whose kept image slots the share would change: that turn
  is stored by its share, so the images the save counted are the ones
  stored. A withheld turn under a bound, whether or not its results fit,
  cuts each stub's kept fields within its share less the notice's room, so
  every stub's notice and place survive the reader's cut too, under a note
  that now reads
  `[cut: N of these fields' M characters; …]`; under a share of about 640
  characters or less a stub keeps a single character of its fields. The
  notice offers raising the inline cap only where a cap at the bound would
  keep more of the result, and a stored copy that leaves out every image
  slot past its cut says so.

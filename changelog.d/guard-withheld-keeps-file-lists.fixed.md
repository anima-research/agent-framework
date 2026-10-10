- A result of the workspace's `materialize`, `sync` or `delete` that the
  tool-result guard withholds now keeps its file lists in its stub, after
  where the original is ("The file lists from its result: {…}"): what
  `materialize` removed from disk and wrote to it, what `sync` took from disk,
  gave up or holds as a conflict, per mount, with any root it accepted, and
  the path `delete` removed. The full result still goes where every withheld
  original goes, and the lists are cut at the inline cap, as any tool result
  is. A tool marks which fields of its result's data are kept with the new
  `ToolResult.keepWhenWithheld`; only these three mark any. Before this, a
  withheld receipt hid even which files a write had touched, such as the
  clobbered `LOG.md` in agent-framework #277.

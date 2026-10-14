- A result of the workspace's `materialize`, `sync` or `delete` that the
  tool-result guard withholds now keeps what it acted on in its stub, after
  where the original is ("Kept from its result: {…}"): what `materialize`
  removed from disk and wrote to it, any root `sync` accepted and what it took
  from disk, gave up or holds as a conflict, per mount, and the path `delete`
  removed (a `delete` that failed keeps nothing, as any failed result). The
  result as stored still goes where every withheld original goes. Past the
  inline cap the kept fields are cut in that order, so a later list can be
  cut away entirely, and the stub says so. While the store is away from the
  batch's branch, the stub stays the bare notice, without the kept fields, as
  every withheld stub does then. A tool marks which fields of its result's
  data are kept with the new `ToolResult.keepWhenWithheld`; only these three
  mark any. Before this, a withheld receipt hid even which files a write had
  touched, such as the clobbered `LOG.md` in agent-framework #277.

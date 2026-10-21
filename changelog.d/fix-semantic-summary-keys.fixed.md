- `semantic_search` keeps a summary apart from another branch's summary with
  the same id. A branch made from an earlier point, as an undo makes one,
  mints summary ids its parent already used, and the index held one item per
  id, so the branch that synced last replaced the other's summary there. A
  summary is now indexed as `sum:<id>@<created>`, by the time it was minted,
  which a branch that inherits it keeps. A hit whose time isn't this branch's
  summary's is dropped as off-branch and counted in `index.droppedOffBranch`.
  Hits still show the id as `sum:<id>`.
- Each branch sends its own summaries to the index. The summary cursor is
  kept in the history module's state, which the store's branches carry, where
  it was the service's one cursor for every branch. So a summary minted on a
  branch and left before a sync is sent once that branch syncs again, whatever
  another branch sent meanwhile.
- **Hosts:** after upgrading, each index embeds every summary once more under
  its new key, a one-time cost on the embed service, and deletes the
  summary's old item, `sum:<id>`, where the service has `/delete`. Where it
  doesn't, the old items stay, and search leaves one out once its summary is
  in the index under its new key.

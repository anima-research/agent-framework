- `semantic_search` keeps a summary apart from another branch's summary with
  the same id. A branch made from an earlier point, as an undo makes one,
  mints summary ids its parent already used, and the index held one item per
  id, so the branch that synced last replaced the other's summary there. A
  summary is now indexed as `sum:<id>@<created>`, by the time it was minted,
  which a branch that inherits it keeps. A hit whose time isn't this branch's
  summary's is dropped as off-branch and counted in `index.droppedOffBranch`.
  Hits still show the id as `sum:<id>`. An item from before, under the id
  alone, can hold another branch's summary, so it's never a hit and isn't
  counted.
- Each branch sends its own messages and summaries to the index. The sync
  cursors are kept in the history module's state, which the store's branches
  carry, where they were the service's one watermark for every branch. So a
  message or summary stored on a branch with cursors and left before a sync
  is sent once that branch syncs again, whatever another branch sent
  meanwhile. A branch with no message cursor yet, from before the upgrade or
  made at a point before its first pass after it, starts its walk at the
  service's watermark, as before. A deleted index starts the cursors over,
  and cursors kept for another namespace aren't used. A cursor is taken as
  no later than the index's newest item of its kind, so an index that keeps
  its namespace and loses its newest items, as a restore from an older
  backup leaves it, gets them again from the next pass, as before.
- **Hosts:** after upgrading, each branch a pass syncs embeds every summary
  it holds once more under its new key, a one-time cost on the embed service
  of one embedding per summary, and deletes the summary's old item,
  `sum:<id>`, where the service has `/delete`. Where it doesn't, the old items
  stay, and search leaves them out. Until a branch's passes have sent its
  summaries under the new key, a search on it can miss one: the search's
  own catch-up sends up to `maxSyncBeforeSearch` new items first (256 by
  default), and background passes send the rest, `maxSyncPerTick` a tick.
  A summary only on a branch no pass syncs keeps its old item, unless
  another branch's pass sends a summary with its id.
  Messages start from the service's watermark, as before. The history
  module's state gains `semanticCursors`. Going back to an earlier release
  leaves summaries indexed under the new keys out of its searches until the
  index is rebuilt. An index restored from a backup taken before this
  release needs rebuilding too: search leaves out its older summaries' old
  items, and no pass sends again a summary a branch's cursor covers.

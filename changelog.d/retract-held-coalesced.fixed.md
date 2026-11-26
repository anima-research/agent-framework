- **Event coalescing:** a coalesced occurrence that is kept in memory, while a
  surgery holds the store or while its agent's context manager refuses its
  work, now counts as unread. A later occurrence of its subject replaces it,
  and a retraction withdraws it: it is taken out of memory, and nothing of it
  is stored at the release. Before, the host counted it as read: an update was
  appended beside it, and a retraction left it to land, followed by the
  retraction's notice where it gave one.
  The release also fills its placement with the row that it is stored as, so
  a retraction after the release, before any request reads that row, removes
  it. A write kept in memory that an earlier try may have stored is still
  never withdrawn.

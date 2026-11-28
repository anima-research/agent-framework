- **Event coalescing:** during a store surgery, or while an agent's context
  manager refuses its work, the host keeps new writes in memory. It now
  counts a coalesced occurrence in memory as unread. A later occurrence of
  its subject replaces it, and a retraction withdraws it. The host then
  takes it out of memory, and stores nothing of it. Before, the host counted
  such an occurrence as read. So an update was appended after it. And a
  retraction didn't withdraw it: the release stored it, and then the
  retraction's notice. An earlier try may have stored a write already. Such
  a write still counts as read while it is in memory.
- **Writes kept in memory:** the release now fills each write's placement,
  as a store outside a hold does. The placement names the row of the write,
  and says if that row is out of its agent's window. So after the release, a
  retraction or a replacement reaches the stored occurrence while no request
  has read it, as for any stored occurrence. The event gate's batched
  wakes use the same placements. After the release, a reply judge can count
  such a write as answered. And `upcomingWakes` no longer says that a
  debounced batch will certainly wake its agent where each of its events is
  such a write placed for that agent.
- **Wakes of a withdrawn write:** a wake whose only cause is a write kept
  in memory now starts no turn once that write is withdrawn. Such a wake is
  a debounced gate batch whose every message is kept, or a wake to read a
  render that is kept. Before, the wake started a turn after the release,
  and that turn read nothing of the write. A batch with a message still to
  read wakes for it. Where each event of a debounced batch is such a
  withdrawn write, `upcomingWakes` no longer says that the batch will
  certainly wake its agent.

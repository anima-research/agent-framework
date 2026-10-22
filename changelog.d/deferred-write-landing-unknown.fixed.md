- A deferred context write whose write threw, and whose store then couldn't
  be read to tell whether it had landed, is no longer put back as one that
  wasn't stored. Until now a later flush stored it again, so a write that
  had landed appeared twice. It's now put back marked as unknown, and before
  it's written again the store is searched for its id: found, it counts as
  written and isn't stored again; not found, it's written; and while the
  store can't be searched, it stays queued, holding what's queued behind it
  for that agent, as a write that keeps failing does. Such an entry's mark
  is persisted with the queue, so after a restart it's still looked up
  before it's written.
  - A write found this way at a flush is carried there, after what the turn
    stored since, though the store holds it before those, so later requests
    place it earlier.
  - Wherever held writes are read or changed, by a module's context, the
    coalescer, a wake's check or a tune-out's backlog, such a write is
    looked up first. One that landed is a stored message from then on, read
    and changed as one, and isn't carried into the turn; one that didn't is
    an ordinary held write. Where the store can't be searched, the
    coalescer reads it as possibly read and shown.
  - A module context's `editMessage` and `removeMessage` can now throw for
    such a held write: where its store can't be searched to tell whether
    it landed, nothing is changed, and the error reads "held write held:…
    may already be stored, and its store can't be searched to tell, so
    nothing was changed. It's refused the same way while the store can't be
    searched; the host log names the store's error".
  - A conversation fork's or ephemeral run's queue, stored when it's
    released, looks such an entry up the same way, and, where the store
    can't be searched, in the window the release reads: found, it isn't
    stored again; where neither can see the store, it's stored anyway where
    the store takes it, and the log says it may now be stored twice. A
    failed reply, or a channel notice the fork or run could act on, among
    such entries reaches the primary once, as the entry itself under its own
    id, so a crash or a restart doesn't tell it twice, as long as the
    release's sync went through. It isn't passed on where the release finds
    the fork or run had read the copy that landed, at its release or at the
    `stop()` that ends it. Where a crash or a failed sync leaves the entry
    to the next boot, boot passes it on anyway, since it can't read that
    window.

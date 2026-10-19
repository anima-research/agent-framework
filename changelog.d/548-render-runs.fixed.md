- A deferred push's render that's still unread now stays where it was
  placed when a later render or notice of the same subject arrives, as
  RFC-006 §5.2 and §3.3 have it: each render describes what changed since
  the one before, so the later render lands after it. A retraction removes
  the subject's unread renders, newest first, and a plain occurrence
  displaces them. A later render used to take the subject's place, so a
  retraction withdrew only that one and left the earlier render queued
  (#548), and a notice arriving after a render had landed unread removed
  it, so the model never read what it described.

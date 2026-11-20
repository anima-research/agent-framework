- **`sameRoundSkipReplyTextPolicy: 'ask'` now holds text on the XML tool
  path,** where it did nothing. That path gives no round content (membrane's
  `roundContent`), so the policy refuses no `skip_reply` there (one that
  asks for a wake it may not have is still refused for that). What a `skip_reply`
  leaves unsent is held as `'skip-reply'` drafts at the turn's end, from
  membrane's own parse of the turn, which keeps thinking apart: a cancelled
  stream's `partialContent`, or a finished response's content.
  - A `skip_reply` that runs ends the turn and cancels its stream. The
    text of every round of that stream is held when the turn ends, after
    the agent's earlier deliveries have run. A turn that another tool
    ends, such as the sleep tool or a module's tool, is as before.
  - At a natural end, the text of a round whose `skip_reply` was refused
    for its wake, or of a response cut off with a `skip_reply` among its
    unrun calls, is held in its place, and the turn's other text is
    delivered as before. In hybrid and explicit mode the held text's
    envelopes set the router's state in order. The same-round think
    policy acts on native tools only, as before: on the XML tool path,
    text beside `think` is held like any other.
  - The resident isn't asked on this path. In locus and hybrid mode the
    turn's receipt names the drafts. Explicit mode writes no receipt, and
    the draft notice at the agent's next turn names them. The heartbeat
    notice, which under `'ask'` says nothing of text
    beside `skip_reply` staying private, is now true on this path.
  - Where a cancelled stream reports no partial content, nothing is held,
    and a `[skip-reply]` line says so.
  - After a budget restart on this path, the first stream's text isn't
    held; the `[speech-not-posted]` notice names it, as before.
  - Who notices: an agent on the XML tool path whose config sets `'ask'`,
    which now gets drafts where it got nothing. No connectome-host release
    passes the key yet.

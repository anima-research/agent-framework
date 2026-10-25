- A module's `queryMessages` and `addMessage` take `{ forAgent }`, naming
  the agent whose window they read or write: a conversation fork's or a
  running sub-agent's own store, or, for an ordinary resident, the
  residents' shared slot. For the subconscious, it's its own store, not
  the residents' slot its compile merges in. Left out, they read and write
  the delivery agent's window, as before: the primary's, or the first
  agent's when none is primary. A name that isn't a registered agent, or
  the empty name, throws, naming the registered ones, so a typo isn't read
  as an empty window and a write for a launcher that has gone is heard. A
  module's `gatherContext(agentName)` can then read the window of the
  agent it gathers for, as retrieval does to key its block to that agent's
  own opening message, and a host can deliver an async subagent's result
  to the window of the fork or sub-agent that launched it, rather than to
  the residents' slot.
  - **A targeted write** is held while its agent's turn is alive, as a
    write for the primary is. For an ephemeral run or a conversation fork,
    whose window nothing reads after it's released, a write it never read
    goes to the primary at its release, as the write itself, through the
    primary's own delivery. It's read as a notice is: once it's below the
    target's consumed watermark, which a compile built to send moves when
    it commits (a row that compile's strategy left out counts as read too),
    and a tool round moves when it injects messages into a stream that
    declares it carries them. So a write that waited for its target's end (a
    run's end, made after its last tool round or any on membrane's XML
    prefill path, or a fork's last turn), one stored while it was idle and
    never sent, one stored at a tool round that ended the turn, and one
    injected into a stream that didn't declare it carries injections go to
    the primary. One still
    queued at the release is also stored in the target's own window, kept
    for investigation, as a queued notice is. A queued one goes as it was
    written; a stored one the store split into shards goes as one text,
    whole. The framework's own writes for a run or a fork are unchanged.
  - **`getMessage`, `editMessage` and `removeMessage`** still read the
    delivery agent's window (the primary's, or the first agent's when none
    is primary), so they don't take an id or handle for a row in a fork's
    or a sub-agent's window: read it with `queryMessages` and the same
    `forAgent`. The residents' shared slot is the primary's window too, for
    a primary that's an ordinary resident, so there they do.
    `metadata.external` with a target throws, since its id map is read in
    the primary's window.

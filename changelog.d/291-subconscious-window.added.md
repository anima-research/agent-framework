- The persistent subconscious reads on its own window (#291): the residents' slot is still merged into its
  context, as the record its window is presented from, and the residents' rows enter its window by its observe edge
  at its own points, so a row the slot takes during its turn enters at its tool boundary or its next start, never
  inside the turn.
  - Its window starts at the oldest active tune-out's start as an index ordinal, fixed once per tune-out, once no
    row it is owed from before the start is out of its window, and kept in `subconscious/<primary>/window-starts`;
    a later tune-out's enter or a restart sets that ordinal again rather than converting the tune-out's sequence
    anew, and a kept ordinal past a shorter window (after a rollback) is clamped. New trace
    `tune-out:subconscious-window` (`how: 'fixed' | 'clamped'`). A start set while the window is the record (a
    branch move whose re-initialization of the subconscious failed) is fixed at the next enter or restart once the
    window presents; one whose setting or keeping failed before a branch move is fixed again at the next enter or
    restart. A restart that finds a start in force kept sets that one, and the oldest active tune-out's start, if it
    isn't kept, waits for the next enter.
  - A cancel of the oldest tune-out while another stays active leaves the start where it was, so the
    subconscious's report on the one cancelled reads what it held, and the start in force is kept too (`inForce`
    in the same state): a restart sets it again rather than the start of the oldest tune-out still active, so the
    window is the same across the restart. The next tune-out's enter sets the oldest active one's start, as it
    always has.
  - A resident's rounds go out to it as a transcript: a line per tool call (the tool's name and its input in brief)
    and per result (the outcome in brief), and none of the resident's thinking, the same in its compiles and in
    what its tool boundary injects (`Agent.setForeignRounds`, `Agent.injectedAsSent`). Its own rounds go as
    stored, and it keeps their signed thinking across a row heard from the residents' slot.
  - A reader fork's framing hand-off presents the held rows it is handed into the fork's window when its run takes
    it on: the fork holds them while it lives (`presentedToAnyone`), so a coalescer doesn't withdraw a row a reader
    was handed, and its view keeps them out of its compile, where the framing shows them. A fork its run refuses
    before taking it on (the host quiesced or stopping, a surgery holding the store) holds none of them: its
    handed rows go back to the next reader, as before, and no row counts as held by a reader that never ran.
- `residentContextOptions(name)`, `subconsciousContextOptions({ serves, name?, reAnchorFraction?,
  maxMessageTokens? })`, `residentViewFilter(name)`, `subconsciousViewFilter(name)` and the
  `ContextManagerOpenOptions` type: how the framework opens a resident's context and the subconscious's, for a host
  that opens one itself (an audit of the store): `ContextManager.open({ store, ...subconsciousContextOptions({
  serves }) })` reads what the live subconscious reads.

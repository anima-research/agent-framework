- The persistent subconscious reads on its own window (#291): the residents' slot is still merged into its
  context, as the record its window is presented from, and the residents' rows enter its window by its observe edge
  at its own points, so a row the slot takes during its turn enters at its tool boundary or its next start, never
  inside the turn.
  - Its window starts at the oldest active tune-out's start as an index ordinal, fixed once per tune-out, once no
    row it is owed from before the start is out of its window, and kept in `subconscious/<primary>/window-starts`;
    a later tune-out's enter or a restart sets that ordinal again rather than converting the tune-out's sequence
    anew, and a kept ordinal past a shorter window (after a rollback) is clamped. New trace
    `tune-out:subconscious-window` (`how: 'fixed' | 'clamped'`).
  - A resident's rounds go out to it as a transcript: a line per tool call (the tool's name and its input in brief)
    and per result (the outcome in brief), and none of the resident's thinking, the same in its compiles and in
    what its tool boundary injects (`Agent.setForeignRounds`, `Agent.injectedAsSent`). Its own rounds go as
    stored, and it keeps their signed thinking across a row heard from the residents' slot.
  - A reader fork's framing hand-off presents the held rows it is handed into the fork's window when its run takes
    it on: the fork holds them while it lives (`presentedToAnyone`), so a coalescer doesn't withdraw a row a reader
    was handed, and its view keeps them out of its compile, where the framing shows them.
- `residentContextOptions(name)`, `subconsciousContextOptions({ serves, name?, reAnchorFraction?,
  maxMessageTokens? })`, `residentViewFilter(name)`, `subconsciousViewFilter(name)` and the
  `ContextManagerOpenOptions` type: how the framework opens a resident's context and the subconscious's, for a host
  that opens one itself (an audit of the store): `ContextManager.open({ store, ...subconsciousContextOptions({
  serves }) })` reads what the live subconscious reads.

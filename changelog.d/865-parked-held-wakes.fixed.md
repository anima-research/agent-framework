- A quiesce or a provider hold no longer merges two wakes that start
  different turns. While the host is quiesced, wakes that share a key wait
  as one. A provider hold also dropped any wake that matched a wake that
  it held. These merges could join a silent heartbeat tick with an
  ordinary wake, a push with no channel with a push on a channel, or a
  system notice with an ordinary push on the same channel. The turn after
  the resume or the hold's end could then run silent, or lose its channel
  (#865). Now a provider hold drops a wake only when it already holds a
  copy of that wake. Two different wakes at the same moment both stay
  held, and the turn that starts when the hold ends handles both. A
  quiesce now keeps a waiting wake for each channel, and not one for all
  of them. One case changes the other way. A quiesce may park wakes on #a,
  then #b, then #a again, with the last two in the same millisecond. The
  resumed turn then speaks in #b, where before it spoke in #a.

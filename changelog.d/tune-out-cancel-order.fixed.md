- A tuned-out channel's cancel writes its backlog dump and makes it
  durable before it records the tune-out's end, as the all-except hold's
  release already ordered them. A cancel that failed between the two, from
  a write that threw or a process that died, left the tune-out ended with
  no dump: its held messages stay out of every resident's window, so
  nothing delivered them, at a restart either. Now a failure before the
  end record, a dump that couldn't be made durable included, leaves the
  tune-out (or the all-except hold) in force, and a later cancel, in this
  process or after a restart, dumps the stored held messages no earlier
  dump covered. Each dump records the held messages it covered, those its
  cap left out among them, so a retried cancel shows none of them twice. A
  tune-out whose writes keep failing stays in force past its end time, its
  cancel tried again every minute, and so does one whose queue of writes
  waiting to be stored is over its cap, until the queue is back under it;
  one that reached its end time while the process was down is tried the
  same way, and the start goes on. A tune-out past its wake budget is
  cancelled at the start too, and its cancel, like an end time's, is tried
  again every minute while it fails. A tool close of the excepted channel
  whose release fails is refused and not recorded: when the release fails
  before the hold's end is recorded, the hold stays in force; when it
  fails after, the hold has ended.

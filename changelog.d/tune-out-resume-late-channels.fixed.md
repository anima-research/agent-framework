- A tune-out on record whose channel isn't registered when the framework
  starts, as one whose MCPL server registers it only later (discord-mcpl
  registers from a task that waits on the policy exchange or a grace
  timer), is resumed at the start as any other is. Before, the start
  resumed only the tune-outs of channels registered by then: such a
  tune-out whose end time passed while the process was down stayed on
  record with its backlog undelivered, and one whose end time was still
  ahead got no end timer, so it ended only when cancelled. Now one past
  its end time is cancelled at the start, its backlog dumped and its end
  recorded; one still running has its end timer and cadence armed; and the
  subconscious's window starts at it, as at one whose channel is
  registered. A later tune-out or all-except hold no longer moves the
  window's start past a tune-out whose channel isn't registered, such as
  one whose server was removed. `tune_out`'s check and a cancel's refusal
  still name only the connected channels' tune-outs.

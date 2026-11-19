- **MCPL coalescing:** the coalescing state no longer grows with every message
  a host admits, and an admission no longer rewrites all of it (#1028).
  - The coalescer's cap of 4,096 subjects, which is unchanged, now reaches
    subjects whose occurrence is placed. Over the cap, each admission walks
    from the subject touched longest ago: it forgets a subject with nothing
    placed, as before, and asks about one with a placed occurrence, which it
    forgets once the agent has read it. It stops at the first subject whose
    occurrence is unread, and passes over one whose batch is pending or
    rendering, so the table can stay over the cap while those last. Before,
    a subject with a placed occurrence was never forgotten, and discord-mcpl
    gives every message its own subject.
  - A later occurrence of a forgotten subject is answered as one of a
    subject the host never saw: its answer names no `priorEventId`, an
    `initial` occurrence's outcome is `first` where it was `appended`, and
    a retraction that carries content is delivered where the host's
    routing sends it, not to the agent that read the forgotten occurrence.
  - Each change is appended to a new state, `mcpl/coalescing-journal`, with
    a number. The table, `mcpl/coalescing`, is written whole, with the
    number of the last change it holds, when the journal has grown to the
    table's size since its last write, after a write that failed, after a
    branch move, at a clean stop, and at a start that finds changes since.
    A start applies only the changes numbered above its table's number.
    Before, the whole table was written within 2 s of each admission, and
    each admission also rewrote the list of receipts since,
    `mcpl/coalescing-recent`, which is now only read, from a store an
    earlier release wrote, and emptied.
  - After a crash, a deferred batch whose render hadn't started renders at
    the next assembly. Before, one accepted since the table's last write was
    delivered as its fallback, since the record of its receipt couldn't say
    whether its render had started. And after a plain occurrence displaced a
    render that was the agent's first view, the next batch of that subject
    is no first view after a crash, since the restored occurrence counts as
    read. Before, the record of its receipt carried no occurrence, so that
    batch could be one.
  - A start refuses, naming `mcpl/coalescing-journal`, when the journal
    after a numbered table can't be read, isn't a list, or holds an item
    that isn't a numbered change of a subject, as it refuses for the table.
  - Going back to an earlier release after a clean stop loses nothing,
    unless the stop's write of the table failed, which the host logs. After
    a crash it loses the changes since the table's last write: a retry of an
    occurrence in that span is admitted again, and a batch accepted in it is
    lost. A start of this release after an earlier one ignores the journal
    that the earlier one left, since that table has no number.

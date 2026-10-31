- **Hosts that set `tuneOut.enabled`:** it's removed, and `create` refuses
  `tuneOut: { enabled: true }`. Residents are offered `tune_out` and `focus`
  only with a reader (`subconscious`, persistent or reader forks). A hold
  without one summarized nothing and woke no one, then handed the resident
  its backlog, undated, all at once when it ended.
  - A hold on record at a start with no reader configured (one this option
    left, or one whose reader the config no longer has), per channel or
    all-except, now ends there with its backlog delivered to the resident,
    under the reason "no reader is configured". Before, a per-channel one
    ended with its held messages left out of every view for good, and an
    all-except one stayed on record.
  - When a persistent reader is stopped, its holds end with it, each backlog
    to the resident ("its reader ended"), where an open-ended one used to
    stay, unread and unwoken, until the resident cancelled it.
  - A hold asked for with no reader is refused, for `focus` (all-except) as
    for one channel, before its options are read.
  - The `tune_out` description drops its sentence about a silent hold, and
    the tool results their silent-hold notes. `tuneOut.announce` is
    unchanged.

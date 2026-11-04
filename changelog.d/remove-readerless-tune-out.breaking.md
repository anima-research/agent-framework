- **Hosts that set `tuneOut.enabled`:** it's removed, and `create` refuses
  `tuneOut: { enabled: true }`. Residents are offered `tune_out` and `focus`
  only with a reader (`subconscious`, persistent or reader forks). A hold
  without one summarized nothing and woke no one, then handed the resident
  its backlog, undated, all at once when it ended. **Migration:** remove the
  key (a TypeScript host that writes `enabled: false` must drop it to
  compile); to keep tune-out, configure a `subconscious`.
  - A hold on record at a start with no reader configured (one this option
    left, or one whose reader the config no longer has), per channel or
    all-except, now ends there (with no MCPL server configured, when the
    first one connects) with its backlog delivered to the resident,
    under the reason "no reader is configured". Before, a per-channel one
    ended with its held messages left out of the resident's view for good,
    and an all-except one stayed on record. A hold whose release fails, as
    when its backlog can't be made durable, stays on record, and the next
    start releases it.
  - When a persistent reader is stopped, its holds end with it, each backlog
    to the resident ("its reader ended"), where an open-ended one used to
    stay, unread and unwoken, until the resident cancelled it.
  - A hold asked for with no reader is refused, for `focus` (all-except) as
    for one channel, before its options are read.
  - The `tune_out` description drops its sentence about a silent hold, and
    the tool results their silent-hold notes. `tuneOut.announce` is
    unchanged.
  - **Sibling versions:** none raised; this needs context-manager
    `^0.24.0`, membrane `^0.8.0` and chronicle `^0.5.1`, as 0.32.0 does.
  - When the persistent reader ends while a hold's release fails (its
    backlog can't be made durable), the release is tried again, backing off
    from a minute, five tries in all; after the last, the hold stays until
    the resident cancels it, or the next start releases it (with no reader)
    or resumes it (with one). `tune_out` / `focus` stay listed while a
    reader is there, or while such a hold is still on record to check or
    cancel.

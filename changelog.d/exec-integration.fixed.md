- Preserve deadline-cap notices when a script yields and when its retained result
  is read later.
- Retire a script's queued wake when its notification is delivered into a live
  tool continuation; keep wakes armed when the turn ends without receiving it.
- Release Python tool waiters during host shutdown and discard late tool results
  instead of raising an unhandled closed-queue error. Host status continues to
  count running background interpreters separately from foreground scripts.

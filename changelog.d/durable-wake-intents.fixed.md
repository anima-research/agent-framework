- `sleep` and `skip_reply(wake_in_seconds)` persist their armed wake intent so
  process restarts re-arm future deadlines or visibly reconcile overdue wakes at most once while journal writes succeed, including across graceful restarts.
- Sleep timers re-arm after backward wall-clock steps instead of silently
  consuming the only wake callback before the promised deadline.

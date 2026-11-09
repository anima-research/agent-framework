- The legacy MCPL engine's reconnect waits are now clamped to a timer's
  limit (2³¹−1 ms, about 24.8 days), as the modern engine's were (#375).
  Before, with an infinite or very large `reconnectMaxIntervalMs`, the wait
  grew past that limit after enough consecutive failures, and a timer given
  a longer delay fires at once, so the backoff's ceiling turned into a
  relaunch every millisecond.

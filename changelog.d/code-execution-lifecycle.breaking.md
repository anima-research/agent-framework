- **Callers of `code_execution`:** foreground calls now return a running `script_id`
  after a bounded observation budget (10 seconds by default). Check `status` and
  use `action=wait` for the result; timeout no longer monopolizes inference until
  script termination. `on_timeout=end_turn` arms completion notification and
  releases the turn. Explicit cancellation remains separate.

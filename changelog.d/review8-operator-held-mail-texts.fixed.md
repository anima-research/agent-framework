- The `context-reinit-failed` alert, which says a restart loses the writes
  kept in memory for a manager that refuses its work, excepts mail, which
  stays held in the registry (0.32.0's said a restart can lose the
  manager's queued writes, mail not excepted). The `store-held-lost` alert
  and its log line, which say the next boot delivers the held mail, add that mail
  whose recipient is gone by then stays held there, marked
  `recipient-gone`.

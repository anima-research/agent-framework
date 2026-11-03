- The `context-reinit-failed` alert, which says a restart loses the writes
  kept in memory for a manager that refuses its work, now excepts mail,
  which stays held in the registry. The `store-held-lost` alert and its log
  line, which say the next boot delivers the held mail, now add that mail
  whose recipient is gone by then stays held there, marked
  `recipient-gone`.

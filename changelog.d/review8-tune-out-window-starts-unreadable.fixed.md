- A read of the subconscious's window-starts record that throws no longer reads as an empty record that the next
  fix writes over. Before, a fix of another active tune-out's start while the read failed wrote that start alone,
  and the starts kept for the others were gone, so a later enter or restart worked them out again from a changed
  presentation order. Now nothing is written over a record that can't be read: the fix isn't kept and is tried
  again at the next presentation, a cancel's forget and a resume's prune leave the record as it is, and an enter
  or restart that can't read it leaves the window start where it was, with a line saying so.

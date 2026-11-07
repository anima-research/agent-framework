- A read of the subconscious's window-starts record that throws doesn't read as an empty record: nothing is
  written over a record that can't be read, so a fix of another active tune-out's start while the read fails
  doesn't drop the starts kept for the others, which a later enter or restart would work out again from a changed
  presentation order. Where the read fails, the fix isn't kept and is tried
  again at the next presentation, a cancel's forget and a resume's prune leave the record as it is, and an enter
  or restart that can't read it leaves the window start where it was, with a line saying so.

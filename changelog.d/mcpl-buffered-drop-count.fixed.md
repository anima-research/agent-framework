- The MCPL connection's buffered-event cap counts each pause's drops: the
  flush line that ends a pause reports that pause's drops, and the drop log
  speaks at each pause's first drop. Previously the count ran for the
  connection's whole life.

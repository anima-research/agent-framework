- Offline recovery on a presented window lets a suppression name a row the cut keeps after the anchor. The cut is
  at the write that presented the anchor, so the rows that write presented with it, and those stored before it,
  stay on the recovery branch, and the suppression planner looks for its endpoints through every row the branch
  keeps, not only up to the anchor's place in the record, so a row kept that way can be taken out in the same
  recovery.

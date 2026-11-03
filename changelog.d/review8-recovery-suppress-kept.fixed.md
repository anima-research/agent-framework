- Offline recovery on a presented window lets a suppression name a row the cut keeps after the anchor. The cut is
  at the write that presented the anchor, so the rows that write presented with it, and those stored before it,
  stay on the recovery branch; the suppression planner looked for its endpoints only up to the anchor's place in
  the record, and refused such a row as "not visible at the selected branch point", so a row kept that way could
  not be taken out in the same recovery. It now looks through every row the branch keeps.

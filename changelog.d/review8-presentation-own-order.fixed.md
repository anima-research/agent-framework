- An agent's own row whose presentation at its write failed keeps its place ahead of the own rows written after
  it when reading it back at the next write fails too (#291). Before, it was dropped from the rows kept for the next
  write, and entered the window after them at the turn's end: a reply after its results, for every later compile.

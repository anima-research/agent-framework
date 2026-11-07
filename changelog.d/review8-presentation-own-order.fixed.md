- An agent's own row whose presentation at its write failed keeps its place ahead of the own rows written after
  it when reading it back at the next write fails too (#291): it stays among the rows kept for the next
  write, so a reply never enters the window after its results.

- A turn that waits for compression keeps the wakes that joined its wait
  when it is released and then refused again. Before, its merged start was
  held alone, so a surgery that dropped the turn, or `abortInference()`,
  ended those wakes too, and they never ran. Now they go back to the queue,
  as 0.34.0 promised. The turn that waits again is the released one, so a
  wake that a surgery removes leaves no channel behind. A withdrawal still
  reaches a joined wake. If the released start rendered a deferred batch,
  that batch's wake reads the stored render once the turn is dropped, and it
  ends if a surgery took the render too. When the released start fails
  before it sends anything, its retry keeps the joined wakes the same way,
  and a stop during the retry's delay puts them back in the queue.

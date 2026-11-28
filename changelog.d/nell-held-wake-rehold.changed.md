- `inference:held`'s `heldRequests` now counts the wakes that a hold takes
  back, so it can be more than 1. `healthSnapshot()`'s
  `budgetHold.heldRequests` and `getHostModeStatus().gatedRequests` count
  those wakes too.

- `inference:held`'s `heldRequests` now counts the wakes that a hold takes
  back. It used to be 1 always. `healthSnapshot()`'s
  `budgetHold.heldRequests` and `getHostModeStatus().gatedRequests` count
  the same requests.

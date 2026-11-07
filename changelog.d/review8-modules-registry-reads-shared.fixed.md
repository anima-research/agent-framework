- The agent registry's deprecated `readsSharedSlot` (on a record, and `sharedSlotReaders()` /
  `readsSharedSlot(name)`) follows the agents registered after it: each live record's flag is worked out again at every registration, so a
  watcher registered before a resident it observes (declared with it, `declaredWith`) reads as reading the shared
  slot once the resident registers, as `readersOf(RESIDENTS_SLOT)` and `observersOf(RESIDENTS_SLOT)` list it.

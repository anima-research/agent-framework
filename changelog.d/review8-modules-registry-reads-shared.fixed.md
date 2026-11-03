- The agent registry's deprecated `readsSharedSlot` (on a record, and `sharedSlotReaders()` /
  `readsSharedSlot(name)`) follows the agents registered after it. It was worked out once, when the record was
  made, so a watcher registered before a resident it observes (declared with it, `declaredWith`) read as not
  reading the shared slot after the resident registered, while `readersOf(RESIDENTS_SLOT)` and
  `observersOf(RESIDENTS_SLOT)` listed it. Each live record's flag is now worked out again at every registration.

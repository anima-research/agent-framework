- Record held-draft notices when a qualifying exhausted stream closes its logical
  turn, before the turn-end draft check, so later catch-up does not repeat them.
  Keep recovery restricted to the same attempt's finished stream and compile.
- Reject non-finite or nonnumeric agent rewind budgets before opening storage.
  Consolidated rewind markers no longer claim uniform raw-record retention
  across window-mode changes; offline repair instructions mark retractions undone.
- Release the inference gate before non-recovery failure policy events, discard
  stale failed-turn snapshots without clearing a successor's, and describe
  uncertain stream settlement without asserting that history needs repair.

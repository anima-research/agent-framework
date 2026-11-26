- When a turn fails or a caller stops it, the turn now reports where its live
  speech went. Its note lists each channel that received that speech. These
  notes are `[inference-failed]` and `[turn-interrupted]`. The list takes the
  same form as a `[delivered]` line. Before, these notes said only that the
  speech was handed on for delivery (#841). The list holds only deliveries
  confirmed before the turn ended, so speech that was held, refused or still
  being routed is not in it. A host can turn off the failure note, which
  removes this list too.

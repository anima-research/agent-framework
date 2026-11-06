- `previewSurgeryMarks` no longer counts a removed message in
  `neverPresented` when an agent's window couldn't be read for it (its
  context's `windowStatusOf` threw): whether that window holds it isn't
  known. The preview logs such messages, naming the agents and the errors.
  Before, the lookup's failure read as "not in that window".
- `previewSurgeryMarks` counts in `neverPresented` a removed message that a window holds but whose agent's view
  leaves it out, as another agent's stored context injection that a window written down from the record kept. It
  counted only held traffic so; such an injection read as shown.

- `previewSurgeryMarks` no longer counts a removed message in
  `neverPresented` when an agent's window couldn't be read for it (its
  context's `windowStatusOf` threw): whether that window holds it isn't
  known. The preview logs such messages, naming the agents and the errors.
  Before, the lookup's failure read as "not in that window".

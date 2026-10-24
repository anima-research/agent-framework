- Modules' context injections now come in the modules' registration order,
  whatever order their `gatherContext` calls finish in, so `compile()`
  places what it places in a fixed order and a stored injection's content
  doesn't change with timing. Before, they came in the order the modules
  finished. A module that answers after its timeout adds nothing; before,
  its late answer was pushed into the array the gather had already
  returned. A module whose `gatherContext` throws rather than rejecting is
  skipped too; before, the throw failed the whole gather, and the turn got
  no module's injections. So is one whose answer isn't an array of objects
  (a string, or an array holding `null`), or holds a `system` entry whose
  content isn't an array of objects (such as `[image, null]`, or an array
  with a hole); before, its entries were kept and reached the turn's
  start, where such content then failed the turn.

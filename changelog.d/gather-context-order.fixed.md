- Modules' context injections now come in the modules' registration order,
  whatever order their `gatherContext` calls finish in, so `compile()`
  places what it places in a fixed order and a stored injection's content
  doesn't change with timing. Before, they came in the order the modules
  finished. A module whose answer is an array holding something other than
  an object (such as `null` or a string), or a `system` entry whose content
  isn't an array of objects (such as `[image, null]`, or an array with a
  hole), is skipped and logged; before, its entries were kept and
  reached the turn's start.

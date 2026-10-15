- Requires context-manager 0.14.1 (was `^0.14.0`). In 0.14.0, under the
  autobiographical strategy, a dry compile that was the first compile after a
  message's removal left later compiles reading message positions from before
  the removal, so every later compile could throw `UncoveredDropError` until
  something rebuilt the order (anima-research/context-manager#180). Previews
  now compile dry, and hiding or suppressing messages answers with one right
  after it removes them, so with 0.14.0 a hide or a suppression could leave the
  agent unable to compile its next turn.
- context-manager 0.14.1 also reads a calibration record written by 0.13.0 or
  earlier, which has no pricing stamp, as provisional rather than learned
  (anima-research/context-manager#179). It may be discarded at load; one above
  1 that puts a compile over budget drops to 1; and the first provider sample
  replaces it. So an agent whose autobiographical strategy uses adaptive
  resolution, upgrading from such a store, can compile a different window when
  the record is read, and again when the first provider sample sets the
  multiplier, rather than over about ten samples. A store that has already run
  a committing compile on 0.14.0 keeps its re-stamped multiplier;
  context-manager 0.14.0's notes give the one-time reset it may still need.

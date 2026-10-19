- Depends on `@animalabs/context-manager` `^0.17.0` (was `^0.15.0`) and
  `@animalabs/membrane` `^0.6.0` (was `^0.5.78`). context-manager 0.16.0
  requires membrane `^0.6.0` and counts a compression attempt's prompt
  through the host's own membrane instance, so the two move together; both
  now declare Node `>=22.12.0`. Under `foldingStrategy: 'kv-unified'` a
  strategy built from a recipe now reads ages in geometric bands, ranks latent
  merge demand with one joint what-if solve, and solves through the subtree
  memo engine, so a compile's solve time no longer grows with the whole
  store (context-manager#45); each has a recipe opt-out
  (`policy.ageBandSteps: 0`, `latentDemandMode: 'individual'`,
  `engine: 'dag'`). context-manager 0.16.0's breaking changes apply to hosts
  that call it directly; see its changelog. Patch release from the v0.21.3
  tag with these dependency bumps only; the work on `main` since 0.21.0 is
  not included.

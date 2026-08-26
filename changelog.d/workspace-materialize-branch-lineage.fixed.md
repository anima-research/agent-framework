- The workspace materialize branch guard checks lineage instead of branch
  identity: a branch that linearly continues the last-materialized branch
  (every fork point at or after the materialized sequence) materializes
  normally, and proven-ancestor pins are re-pinned at boot — so an
  out-of-band repair that leaves the store on a fork-at-head child branch no
  longer wedges every materialize until manual surgery. The guard is scoped
  to the mounts being materialized (one mount's stale pin no longer blocks
  the rest, blocked mounts are reported as `skipped`), `canMaterialize` in
  `status` shares the guard's exact predicate instead of a divergent
  computation, and genuine divergence can be overridden with the new
  `force: true` input, which resets tracking and re-materializes the full
  tree (an incremental diff across divergent history silently writes
  nothing).
